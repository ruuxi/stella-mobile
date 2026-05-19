const IDLE_VARIATIONS: readonly string[] = [
  "Thinking",
  "Mulling it over",
  "Figuring it out",
  "Working it out",
  "Putting it together",
  "Lining things up",
  "Weighing options",
  "Settling on a plan",
  "Sorting it out",
  "Considering",
];

const REASONING_VARIATIONS: readonly string[] = [
  "Thinking",
  "Mulling it over",
  "Working through it",
  "Turning it over",
  "Reasoning",
  "Chewing on this",
  "Connecting the dots",
  "Sitting with it",
  "Untangling it",
  "Piecing it together",
];

const AGENT_WORK_VARIATIONS: readonly string[] = [
  "On it",
  "Working on it",
  "Got it",
  "Handling it",
  "Taking care of it",
  "Sorting it",
  "Doing the thing",
  "Making it happen",
  "Just a sec",
  "One moment",
];

const TOOL_STATUS_BY_NAME: Record<string, readonly string[]> = {
  image_gen: [
    "Sketching",
    "Drawing",
    "Sketching it out",
    "Drawing it up",
    "Mocking it up",
    "Painting a picture",
    "Whipping up a visual",
    "Making an image",
    "Starting the render",
    "Setting the scene",
  ],
  web: [
    "Searching",
    "Looking it up",
    "Googling",
    "Checking online",
    "Searching the web",
    "Looking that up",
    "Browsing",
    "Hunting it down",
    "Asking the internet",
    "Finding out",
  ],
  schedule: [
    "Scheduling",
    "Calendaring",
    "Penciling it in",
    "Booking it",
    "Saving the date",
    "Adding to your calendar",
    "Locking in the time",
    "Marking it down",
    "Setting a reminder",
    "Putting it on the schedule",
  ],
  context: [
    "Looking back",
    "Checking my notes",
    "Checking recent notes",
    "Finding the thread",
    "Looking for the reference",
    "Checking recent activity",
    "Finding the background",
    "Catching up",
    "Getting oriented",
    "Looking at what matters",
  ],
  askquestion: [
    "One quick question",
    "Quick question",
    "Just a quick check",
    "Need to ask you something",
    "One sec",
    "Got something to ask",
    "Quick check with you",
    "Putting some options together",
    "One thing to confirm",
    "Want to double-check something",
  ],
  spawn_agent: AGENT_WORK_VARIATIONS,
  send_input: AGENT_WORK_VARIATIONS,
  pause_agent: [
    "Pausing",
    "Holding up",
    "Hitting pause",
    "Putting a pin in it",
    "Holding off",
    "Taking a beat",
    "Easing off",
    "Slowing down",
    "Putting it on hold",
    "Standing by",
  ],
};

const FALLBACK_VARIATIONS: readonly string[] = [
  "Working on it",
  "On it",
  "Just a sec",
  "One moment",
  "Handling it",
  "Looking into it",
  "On the case",
];

const hashSeed = (seed: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

const pickVariation = (
  options: readonly string[],
  seed: string | undefined,
): string => {
  if (options.length === 0) return "";
  if (options.length === 1 || !seed) return options[0]!;
  return options[hashSeed(seed) % options.length]!;
};

export function computeWorkingIndicatorStatus({
  status,
  toolName,
  seed,
  isReasoning,
}: {
  status?: string;
  toolName?: string;
  seed?: string;
  isReasoning?: boolean;
} = {}): string {
  if (status) return status;

  if (toolName) {
    const normalizedToolName = toolName.toLowerCase();
    const mapped = TOOL_STATUS_BY_NAME[normalizedToolName];
    if (mapped) return pickVariation(mapped, seed ?? normalizedToolName);
    return pickVariation(FALLBACK_VARIATIONS, seed ?? normalizedToolName);
  }

  if (isReasoning) return pickVariation(REASONING_VARIATIONS, seed);

  return pickVariation(IDLE_VARIATIONS, seed);
}
