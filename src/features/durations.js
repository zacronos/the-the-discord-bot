// Poll duration choices (seconds). 7 days is the recommended default; test
// mode adds short options that must never be used on a real server.
const STANDARD = [
  { label: '3 days', seconds: 259_200 },
  { label: '5 days', seconds: 432_000 },
  { label: '7 days (recommended)', seconds: 604_800, default: true },
  { label: '14 days', seconds: 1_209_600 },
  { label: '30 days', seconds: 2_592_000 },
];
const TEST_ONLY = [
  { label: '5 minutes (TESTING ONLY)', seconds: 300 },
  { label: '30 minutes (TESTING ONLY)', seconds: 1_800 },
];

const choices = (testMode) => (testMode ? [...TEST_ONLY, ...STANDARD] : STANDARD);

export function durationSelectOptions(testMode = false) {
  return choices(testMode).map((choice) => ({
    label: choice.label,
    value: String(choice.seconds),
    default: choice.default === true,
  }));
}

export function isAllowedDurationSeconds(seconds, testMode = false) {
  return choices(testMode).some((choice) => choice.seconds === seconds);
}
