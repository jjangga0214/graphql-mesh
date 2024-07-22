/* eslint-disable @typescript-eslint/no-floating-promises */
import type { ExecutionResult, GraphQLError } from 'graphql';
import { getInterpolatedHeadersFactory } from '@graphql-mesh/string-interpolation';
import {
  defaultPrintFn,
  type DisposableExecutor,
  type Transport,
} from '@graphql-mesh/transport-common';
import { createGraphQLError } from '@graphql-tools/utils';
import { Repeater, type Push } from '@repeaterjs/repeater';
import { crypto } from '@whatwg-node/fetch';

export interface HTTPCallbackTransportOptions {
  /**
   * The gateway's public URL, which your subgraphs access, must include the path configured on the gateway.
   *
   * @default http://localhost:4000/callback
   */
  public_url?: string;
  /**
   * The path of the router's callback endpoint
   *
   * @default /callback
   */
  path?: string;
  /**
   * @default 5000
   */
  heartbeat_interval?: number;
}

type HTTPCallbackMessage =
  | {
      kind: 'subscription';
      action: 'check';
      id: string;
      verifier: string;
    }
  | {
      kind: 'subscription';
      action: 'next';
      id: string;
      verifier: string;
      payload: ExecutionResult;
    }
  | {
      kind: 'subscription';
      action: 'complete';
      id: string;
      verifier: string;
      errors?: GraphQLError[];
    };

function createTimeoutError() {
  return createGraphQLError('Subscription timed out', {
    extensions: {
      code: 'TIMEOUT_ERROR',
    },
  });
}

export default {
  getSubgraphExecutor({ transportEntry, fetch, pubsub, logger }) {
    let headersInConfig: Record<string, string> | undefined;
    if (typeof transportEntry.headers === 'string') {
      headersInConfig = JSON.parse(transportEntry.headers);
    }
    if (Array.isArray(transportEntry.headers)) {
      headersInConfig = Object.fromEntries(transportEntry.headers);
    }

    const headersFactory = getInterpolatedHeadersFactory(headersInConfig);

    const verifier = crypto.randomUUID();
    if (!pubsub) {
      throw new Error(`You must provide a pubsub instance to http-callbacks transport!
    Example:
      export const serveConfig: MeshServeCLIConfig = {
        pubsub: new PubSub(),
      }
    See documentation: https://the-guild.dev/docs/mesh/pubsub`);
    }
    const heartbeats = new Map<string, ReturnType<typeof setTimeout>>();
    const stopFnSet = new Set<VoidFunction>();
    const httpCallbackExecutor: DisposableExecutor = function httpCallbackExecutor(execReq) {
      const query = defaultPrintFn(execReq.document);
      const subscriptionId = crypto.randomUUID();
      const subscriptionLogger = logger.child(subscriptionId);
      const callbackPath = transportEntry.options?.path || '/callback';
      const callbackUrlObj = new URL(
        transportEntry.options.public_url || `http://localhost:4000${callbackPath}`,
      );
      callbackUrlObj.pathname += `/${subscriptionId}`;
      const subscriptionCallbackPath = `${callbackPath}/${subscriptionId}`;
      const heartbeatIntervalMs = transportEntry.options.heartbeat_interval || 50000;
      const fetchBody = JSON.stringify({
        query,
        variables: execReq.variables,
        operationName: execReq.operationName,
        extensions: {
          ...(execReq.extensions || {}),
          subscription: {
            callbackUrl: callbackUrlObj.toString(),
            subscriptionId,
            verifier,
            heartbeatIntervalMs,
          },
        },
      });
      let stopSubscription: (error?: Error) => void = error => {
        if (error) {
          throw error;
        }
      };
      heartbeats.set(
        subscriptionId,
        setTimeout(() => {
          stopSubscription(createTimeoutError());
        }, heartbeatIntervalMs),
      );
      subscriptionLogger.debug(
        `Subscribing to ${transportEntry.location} with callbackUrl: ${callbackUrlObj.toString()}`,
      );
      let pushFn: Push<ExecutionResult> = () => {
        throw createGraphQLError(
          `Subgraph does not look like configured correctly. Check your subgraph setup.`,
        );
      };
      const res$ = fetch(transportEntry.location, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headersFactory({
            env: process.env,
            root: execReq.rootValue,
            context: execReq.context,
            info: execReq.info,
          }),
          Accept: 'application/json;callbackSpec=1.0; charset=utf-8',
        },
        body: fetchBody,
      })
        .then(res => {
          if (!res.ok) {
            stopSubscription(
              createGraphQLError(`HTTP Error`, {
                extensions: {
                  http: {
                    status: res.status,
                  },
                },
              }),
            );
          }
          return res.json();
        })
        .then((resJson: ExecutionResult) => {
          logger.debug(`Subscription request received`, resJson);
          if (resJson.errors) {
            if (resJson.errors.length === 1) {
              stopSubscription(createGraphQLError(resJson.errors[0].message, resJson.errors[0]));
            } else {
              stopSubscription(
                new AggregateError(
                  resJson.errors.map(err => createGraphQLError(err.message, err)),
                  resJson.errors.map(err => err.message).join('\n'),
                ),
              );
            }
          } else if (resJson.data != null) {
            pushFn(resJson.data);
            stopSubscription();
          }
        })
        .catch(e => {
          logger.debug(`Subscription request failed`, e);
          stopSubscription(e);
        });
      execReq.context?.waitUntil(res$);
      return new Repeater<ExecutionResult>((push, stop) => {
        pushFn = push;
        stopSubscription = stop;
        stopFnSet.add(stop);
        logger.debug(`Listening to ${subscriptionCallbackPath}`);
        const subId = pubsub.subscribe(
          `webhook:post:${subscriptionCallbackPath}`,
          (message: HTTPCallbackMessage) => {
            logger.debug(`Received message from ${subscriptionCallbackPath}`, message);
            if (message.verifier !== verifier) {
              return;
            }
            const existingHeartbeat = heartbeats.get(subscriptionId);
            if (existingHeartbeat) {
              clearTimeout(existingHeartbeat);
            }
            heartbeats.set(
              subscriptionId,
              setTimeout(() => {
                stopSubscription(createTimeoutError());
              }, heartbeatIntervalMs),
            );
            switch (message.action) {
              case 'check':
                break;
              case 'next':
                push(message.payload);
                break;
              case 'complete':
                if (message.errors) {
                  if (message.errors.length === 1) {
                    stopSubscription(
                      createGraphQLError(message.errors[0].message, message.errors[0]),
                    );
                  } else {
                    stopSubscription(
                      new AggregateError(
                        message.errors.map(err => createGraphQLError(err.message, err)),
                      ),
                    );
                  }
                } else {
                  stopSubscription();
                }
                break;
            }
          },
        );
        stop.finally(() => {
          pubsub.unsubscribe(subId);
          clearTimeout(heartbeats.get(subscriptionId));
          heartbeats.delete(subscriptionId);
          stopFnSet.delete(stop);
        });
      });
    };
    httpCallbackExecutor[Symbol.asyncDispose] = function () {
      for (const stop of stopFnSet) {
        stop();
      }
      for (const interval of heartbeats.values()) {
        clearTimeout(interval);
      }
    };
    return httpCallbackExecutor;
  },
} satisfies Transport<'http-callback', HTTPCallbackTransportOptions>;