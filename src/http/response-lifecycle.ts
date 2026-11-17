export type ResponseFinishCleanup = () => void | Promise<void>;
export type ResponseAbortCleanup = () => void | Promise<void>;

export interface ResponseLifecycle {
  onFinish: ResponseFinishCleanup;
  onAbort?: ResponseAbortCleanup;
}

const RESPONSE_LIFECYCLE = Symbol.for("@getpaseo/hub/response-lifecycle");

interface LifecycleResponse extends Response {
  [RESPONSE_LIFECYCLE]?: ResponseLifecycle;
}

export function registerResponseFinishCleanup(
  response: Response,
  cleanup: ResponseFinishCleanup,
): Response {
  return registerResponseLifecycle(response, { onFinish: cleanup });
}

export function registerResponseLifecycle(
  response: Response,
  lifecycle: ResponseLifecycle,
): Response {
  Object.defineProperty(response, RESPONSE_LIFECYCLE, { value: lifecycle, configurable: true });
  return response;
}

export function takeResponseLifecycle(response: Response): ResponseLifecycle | undefined {
  const owned = response as LifecycleResponse;
  const lifecycle = owned[RESPONSE_LIFECYCLE];
  delete owned[RESPONSE_LIFECYCLE];
  return lifecycle;
}
