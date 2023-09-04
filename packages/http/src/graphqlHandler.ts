import { CORSOptions, createYoga, useLogger } from 'graphql-yoga';
import { MeshInstance } from '@graphql-mesh/runtime';

export const graphqlHandler = ({
  getBuiltMesh,
  playgroundTitle,
  playgroundEnabled,
  graphqlEndpoint,
  corsConfig,
  batchingLimit,
}: {
  getBuiltMesh: () => Promise<MeshInstance>;
  playgroundTitle: string;
  playgroundEnabled: boolean;
  graphqlEndpoint: string;
  corsConfig: CORSOptions;
  batchingLimit?: number;
}) => {
  let yoga: ReturnType<typeof createYoga>;
  let yoga$: Promise<ReturnType<typeof createYoga>>;
  return (request: Request, ctx: any) => {
    if (yoga) {
      return yoga.handleRequest(request, ctx);
    }
    if (!yoga$) {
      yoga$ = getBuiltMesh().then(mesh => {
        yoga = createYoga({
          plugins: [
            ...mesh.plugins,
            useLogger({
              skipIntrospection: true,
              logFn: (eventName, { args }) => {
                if (eventName.endsWith('-start')) {
                  mesh.logger.debug(`\t headers: `, args.contextValue.headers);
                }
              },
            }),
          ],
          logging: mesh.logger,
          maskedErrors: false,
          graphiql: playgroundEnabled && {
            title: playgroundTitle,
          },
          cors: corsConfig,
          graphqlEndpoint,
          landingPage: false,
          batching: batchingLimit ? { limit: batchingLimit } : false,
        });
        return yoga;
      });
    }
    return yoga$.then(yoga => yoga.handleRequest(request, ctx));
  };
};
