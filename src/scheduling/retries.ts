import type { RetryPolicy } from "../commands/types.ts";

export function validateRetryPolicy(policy: RetryPolicy, scope = "RETRY_POLICY"): void {
  if (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1) throw new Error(`${scope}_INVALID: maxAttempts must be a positive safe integer`);
  if (!Array.isArray(policy.backoffSeconds) || policy.backoffSeconds.length !== policy.maxAttempts - 1) throw new Error(`${scope}_INVALID: backoffSeconds must contain one delay for every retry`);
  if (policy.backoffSeconds.some((delay) => !Number.isSafeInteger(delay) || delay < 0)) throw new Error(`${scope}_INVALID: backoffSeconds must contain nonnegative safe integers`);
}

export function retryAvailable(policy: RetryPolicy, failedAttempt: number): boolean {
  return failedAttempt < policy.maxAttempts;
}

export function retryNotBefore(policy: RetryPolicy, failedAttempt: number, failedAt: string): string {
  if (!retryAvailable(policy, failedAttempt)) throw new Error("RETRY_EXHAUSTED: no retry remains under the Operation policy");
  const delay = policy.backoffSeconds[failedAttempt - 1];
  if (delay === undefined) throw new Error("RETRY_POLICY_INVALID: missing backoff for retry attempt");
  return new Date(Date.parse(failedAt) + delay * 1_000).toISOString();
}
