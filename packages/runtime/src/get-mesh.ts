import {
  GraphQLSchema,
  GraphQLResolveInfo,
  OperationTypeNode,
  GraphQLObjectType,
  print,
  SelectionSetNode,
  Kind,
  isLeafType,
  getNamedType,
} from 'graphql';
import { ExecuteMeshFn, GetMeshOptions, SubscribeMeshFn } from './types';
import {
  MeshPubSub,
  KeyValueCache,
  RawSourceOutput,
  GraphQLOperation,
  SelectionSetParamOrFactory,
  SelectionSetParam,
  Logger,
  MeshTransform,
} from '@graphql-mesh/types';

import { MESH_CONTEXT_SYMBOL, MESH_API_CONTEXT_SYMBOL } from './constants';
import {
  applySchemaTransforms,
  getInterpolatedStringFactory,
  groupTransforms,
  ResolverDataBasedFactory,
  DefaultLogger,
  parseWithCache,
} from '@graphql-mesh/utils';

import { InMemoryLiveQueryStore } from '@n1ru4l/in-memory-live-query-store';
import { delegateToSchema, IDelegateToSchemaOptions, SubschemaConfig } from '@graphql-tools/delegate';
import { BatchDelegateOptions, batchDelegateToSchema } from '@graphql-tools/batch-delegate';
import { WrapQuery } from '@graphql-tools/wrap';
import { inspect, isDocumentNode, memoize1, parseSelectionSet } from '@graphql-tools/utils';
import { envelop, useErrorHandler, useExtendContext, useLogger, useSchema } from '@envelop/core';
import { useLiveQuery } from '@envelop/live-query';

type EnvelopPlugins = Parameters<typeof envelop>[0]['plugins'];

export interface MeshInstance<TMeshContext = any> {
  execute: ExecuteMeshFn;
  subscribe: SubscribeMeshFn;
  schema: GraphQLSchema;
  rawSources: RawSourceOutput[];
  destroy: () => void;
  pubsub: MeshPubSub;
  cache: KeyValueCache;
  liveQueryStore: InMemoryLiveQueryStore;
  logger: Logger;
  meshContext: TMeshContext;
  plugins: EnvelopPlugins;
  getEnveloped: ReturnType<typeof envelop>;
}

const memoizedGetEnvelopedFactory = memoize1((plugins: EnvelopPlugins) => envelop({ plugins }));

export async function getMesh<TMeshContext = any>(options: GetMeshOptions): Promise<MeshInstance<TMeshContext>> {
  const rawSources: RawSourceOutput[] = [];
  const { pubsub, cache, logger = new DefaultLogger('🕸️'), additionalEnvelopPlugins = [] } = options;

  const getMeshLogger = logger.child('GetMesh');
  getMeshLogger.debug(() => `Getting subschemas from source handlers`);
  let failed = false;
  await Promise.allSettled(
    options.sources.map(async apiSource => {
      const apiName = apiSource.name;
      const sourceLogger = logger.child(apiName);
      sourceLogger.debug(() => `Generating the schema`);
      try {
        const source = await apiSource.handler.getMeshSource();
        sourceLogger.debug(() => `The schema has been generated successfully`);

        let apiSchema = source.schema;

        sourceLogger.debug(() => `Analyzing transforms`);

        let transforms: MeshTransform[];

        const { wrapTransforms, noWrapTransforms } = groupTransforms(apiSource.transforms);

        if (!wrapTransforms?.length && noWrapTransforms?.length) {
          sourceLogger.debug(() => `${noWrapTransforms.length} bare transforms found and applying`);
          apiSchema = applySchemaTransforms(apiSchema, source as SubschemaConfig, null, noWrapTransforms);
        } else {
          transforms = apiSource.transforms;
        }

        rawSources.push({
          name: apiName,
          schema: apiSchema,
          executor: source.executor,
          transforms,
          contextVariables: source.contextVariables || [],
          handler: apiSource.handler,
          batch: 'batch' in source ? source.batch : true,
          merge: apiSource.merge,
        });
      } catch (e: any) {
        sourceLogger.error(`Failed to generate the schema ${e.stack || e.message}`);
        failed = true;
      }
    })
  );

  if (failed) {
    throw new Error(
      `Schemas couldn't be generated successfully. Check for the logs by running Mesh with DEBUG=1 environmental variable to get more verbose output.`
    );
  }

  getMeshLogger.debug(() => `Schemas have been generated by the source handlers`);

  getMeshLogger.debug(() => `Merging schemas using the defined merging strategy.`);
  const unifiedSchema = await options.merger.getUnifiedSchema({
    rawSources,
    typeDefs: options.additionalTypeDefs,
    resolvers: options.additionalResolvers,
    transforms: options.transforms,
  });

  getMeshLogger.debug(() => `Creating Live Query Store`);
  const liveQueryStore = new InMemoryLiveQueryStore({
    includeIdentifierExtension: true,
  });

  const liveQueryInvalidationFactoryMap = new Map<string, ResolverDataBasedFactory<string>[]>();

  options.liveQueryInvalidations?.forEach(liveQueryInvalidation => {
    const rawInvalidationPaths = liveQueryInvalidation.invalidate;
    const factories = rawInvalidationPaths.map(rawInvalidationPath =>
      getInterpolatedStringFactory(rawInvalidationPath)
    );
    liveQueryInvalidationFactoryMap.set(liveQueryInvalidation.field, factories);
  });

  getMeshLogger.debug(() => `Building Mesh Context`);
  const meshContext: Record<string, any> = {
    pubsub,
    cache,
    liveQueryStore,
    logger,
    [MESH_CONTEXT_SYMBOL]: true,
  };
  getMeshLogger.debug(() => `Attaching in-context SDK, pubsub, cache and liveQueryStore to the context`);
  const sourceMap = unifiedSchema.extensions.sourceMap as Map<RawSourceOutput, GraphQLSchema>;
  await Promise.all(
    rawSources.map(async rawSource => {
      const rawSourceLogger = logger.child(`${rawSource.name}`);

      const rawSourceContext: any = {
        rawSource,
        [MESH_API_CONTEXT_SYMBOL]: true,
      };
      const transformedSchema = sourceMap.get(rawSource);
      const rootTypes: Record<OperationTypeNode, GraphQLObjectType> = {
        query: transformedSchema.getQueryType(),
        mutation: transformedSchema.getMutationType(),
        subscription: transformedSchema.getSubscriptionType(),
      };

      rawSourceLogger.debug(() => `Generating In Context SDK`);
      for (const operationType in rootTypes) {
        const rootType: GraphQLObjectType = rootTypes[operationType];
        if (rootType) {
          rawSourceContext[rootType.name] = {};
          const rootTypeFieldMap = rootType.getFields();
          for (const fieldName in rootTypeFieldMap) {
            const rootTypeField = rootTypeFieldMap[fieldName];
            const inContextSdkLogger = rawSourceLogger.child(`InContextSDK.${rootType.name}.${fieldName}`);
            const shouldHaveSelectionSet = !isLeafType(getNamedType(rootTypeField.type));
            rawSourceContext[rootType.name][fieldName] = async ({
              root,
              args,
              context,
              info = {
                fieldName,
                fieldNodes: [],
                returnType: rootTypeField.type,
                parentType: rootType,
                path: {
                  typename: rootType.name,
                  key: fieldName,
                  prev: undefined,
                },
                schema: unifiedSchema,
                fragments: {},
                rootValue: root,
                operation: {
                  kind: Kind.OPERATION_DEFINITION,
                  operation: operationType as OperationTypeNode,
                  selectionSet: {
                    kind: Kind.SELECTION_SET,
                    selections: [],
                  },
                },
                variableValues: {},
                cacheControl: {
                  setCacheHint: () => {},
                  cacheHint: {},
                },
              },
              selectionSet,
              key,
              argsFromKeys,
              valuesFromResults,
            }: {
              root: any;
              args: any;
              context: any;
              info: GraphQLResolveInfo;
              selectionSet: SelectionSetParamOrFactory;
              key?: string;
              argsFromKeys?: (keys: string[]) => any;
              valuesFromResults?: (result: any, keys?: string[]) => any;
            }) => {
              inContextSdkLogger.debug(
                () => `Called with
- root: ${inspect(root)}
- args: ${inspect(args)}
- key: ${inspect(key)}`
              );
              const commonDelegateOptions: IDelegateToSchemaOptions = {
                schema: rawSource as SubschemaConfig,
                rootValue: root,
                operation: operationType as OperationTypeNode,
                fieldName,
                returnType: rootTypeField.type,
                context,
                transformedSchema,
                info,
              };
              if (selectionSet) {
                const selectionSetFactory = normalizeSelectionSetParamOrFactory(selectionSet);
                const path = [fieldName];
                const wrapQueryTransform = new WrapQuery(path, selectionSetFactory, identical);
                commonDelegateOptions.transforms = [wrapQueryTransform];
              }
              if (shouldHaveSelectionSet) {
                let selectionCount = 0;
                for (const fieldNode of info.fieldNodes) {
                  if (fieldNode.selectionSet != null) {
                    selectionCount += fieldNode.selectionSet.selections.length;
                  }
                }
                if (selectionCount === 0) {
                  if (!selectionSet) {
                    throw new Error(
                      `You have to provide 'selectionSet' for context.${rawSource.name}.${rootType.name}.${fieldName}`
                    );
                  }
                  commonDelegateOptions.info = {
                    ...info,
                    fieldNodes: [
                      {
                        ...info.fieldNodes[0],
                        selectionSet: {
                          kind: Kind.SELECTION_SET,
                          selections: [
                            {
                              kind: Kind.FIELD,
                              name: {
                                kind: Kind.NAME,
                                value: '__typename',
                              },
                            },
                          ],
                        },
                      },
                      ...info.fieldNodes.slice(1),
                    ],
                  };
                }
              }
              if (key && argsFromKeys) {
                const batchDelegationOptions: BatchDelegateOptions = {
                  ...commonDelegateOptions,
                  key,
                  argsFromKeys,
                  valuesFromResults,
                };
                return batchDelegateToSchema(batchDelegationOptions);
              } else {
                const options: IDelegateToSchemaOptions = {
                  ...commonDelegateOptions,
                  args,
                };
                const result = await delegateToSchema(options);
                if (valuesFromResults) {
                  return valuesFromResults(result);
                }
                return result;
              }
            };
          }
        }
      }
      meshContext[rawSource.name] = rawSourceContext;
    })
  );

  const plugins: EnvelopPlugins = [
    useSchema(unifiedSchema),
    useExtendContext(() => meshContext),
    useLiveQuery({ liveQueryStore }),
    useLogger({
      logFn: (eventName, args) => logger.child(eventName).debug(() => inspect(args)),
    }),
    useErrorHandler(errors => {
      errors.forEach(error => logger.error(error.stack || error.message));
    }),
    {
      onParse({ setParseFn }) {
        setParseFn(parseWithCache);
      },
      async onResolverCalled(resolverData) {
        return async (result: any) => {
          if (resolverData?.info?.parentType && resolverData?.info?.fieldName) {
            const path = `${resolverData.info.parentType.name}.${resolverData.info.fieldName}`;
            if (liveQueryInvalidationFactoryMap.has(path)) {
              const invalidationPathFactories = liveQueryInvalidationFactoryMap.get(path);
              const invalidationPaths = invalidationPathFactories.map(invalidationPathFactory =>
                invalidationPathFactory({ ...resolverData, env: process.env, result })
              );
              await liveQueryStore.invalidate(invalidationPaths);
            }
          }
        };
      },
    },
    ...additionalEnvelopPlugins,
  ];

  const EMPTY_ROOT_VALUE: any = {};
  const EMPTY_CONTEXT_VALUE: any = {};
  const EMPTY_VARIABLES_VALUE: any = {};

  async function meshExecute<TVariables = any, TContext = any, TRootValue = any, TData = any>(
    documentOrSDL: GraphQLOperation<TData, TVariables>,
    variableValues: TVariables = EMPTY_VARIABLES_VALUE,
    contextValue: TContext = EMPTY_CONTEXT_VALUE,
    rootValue: TRootValue = EMPTY_ROOT_VALUE,
    operationName?: string
  ) {
    const getEnveloped = memoizedGetEnvelopedFactory(plugins);
    const { execute, contextFactory, parse } = getEnveloped(contextValue);

    return execute({
      document: typeof documentOrSDL === 'string' ? parse(documentOrSDL) : documentOrSDL,
      contextValue: await contextFactory(),
      rootValue,
      variableValues: variableValues as any,
      schema: unifiedSchema,
      operationName,
    });
  }

  async function meshSubscribe<TVariables = any, TContext = any, TRootValue = any, TData = any>(
    documentOrSDL: GraphQLOperation<TData, TVariables>,
    variableValues: TVariables = EMPTY_VARIABLES_VALUE,
    contextValue: TContext = EMPTY_CONTEXT_VALUE,
    rootValue: TRootValue = EMPTY_ROOT_VALUE,
    operationName?: string
  ) {
    const getEnveloped = memoizedGetEnvelopedFactory(plugins);
    const { subscribe, contextFactory, parse } = getEnveloped(contextValue);

    return subscribe({
      document: typeof documentOrSDL === 'string' ? parse(documentOrSDL) : documentOrSDL,
      contextValue: await contextFactory(),
      rootValue,
      variableValues: variableValues as any,
      schema: unifiedSchema,
      operationName,
    });
  }

  return {
    execute: meshExecute,
    subscribe: meshSubscribe,
    schema: unifiedSchema,
    rawSources,
    cache,
    pubsub,
    destroy: () => pubsub.publish('destroy', undefined),
    liveQueryStore,
    logger,
    meshContext: meshContext as TMeshContext,
    plugins,
    get getEnveloped() {
      return memoizedGetEnvelopedFactory(plugins);
    },
  };
}

function normalizeSelectionSetParam(selectionSetParam: SelectionSetParam) {
  if (typeof selectionSetParam === 'string') {
    return parseSelectionSet(selectionSetParam);
  }
  if (isDocumentNode(selectionSetParam)) {
    return parseSelectionSet(print(selectionSetParam));
  }
  return selectionSetParam;
}

function normalizeSelectionSetParamOrFactory(
  selectionSetParamOrFactory: SelectionSetParamOrFactory
): (subtree: SelectionSetNode) => SelectionSetNode {
  return function getSelectionSet(subtree: SelectionSetNode) {
    if (typeof selectionSetParamOrFactory === 'function') {
      const selectionSetParam = selectionSetParamOrFactory(subtree);
      return normalizeSelectionSetParam(selectionSetParam);
    } else {
      return normalizeSelectionSetParam(selectionSetParamOrFactory);
    }
  };
}

function identical<T>(val: T): T {
  return val;
}
