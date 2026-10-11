/**
 * The longest wait a Node timer keeps: 2147483647 ms (2^31 - 1, about 24.8 days). `setTimeout` takes a longer
 * delay as 1 ms and says so only in a `TimeoutOverflowWarning`, so a deadline of 30 days would strike at once.
 * A setting a tree writes that a timer waits on is held to this bound by the rule that judges the setting.
 */
export const TIMER_MAX_MS = 2 ** 31 - 1;
