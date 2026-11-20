import type { ApiKeyScope } from "./api-key-contract.js";
import type { OperationAuthorization, OperationAuthorizationResult } from "./api-keys.js";

export type OperationScope = ApiKeyScope | "runs:stop";

export interface OperationAuthenticator {
  authorize(request: Request, requiredScope: OperationScope): Promise<OperationAuthorizationResult>;
  reauthorize(access: OperationAuthorization, requiredScope: OperationScope): Promise<boolean>;
}
