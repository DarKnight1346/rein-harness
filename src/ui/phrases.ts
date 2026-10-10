/**
 * What the working line says while the agent thinks, instead of a plain "Thinking…": one of
 * these, picked at random for each message you send (never the same twice in a row).
 */
export const PHRASES = [
  'Pondering', 'Noodling', 'Mulling it over', 'Percolating', 'Brewing ideas', 'Cogitating', 'Ruminating', 'Chewing on it',
  'Connecting dots', 'Untangling spaghetti', 'Herding cats', 'Wrangling bits', 'Polishing pixels', 'Tuning the vibes', 'Consulting the rubber duck', 'Asking the duck',
  'Shuffling bytes', 'Juggling semicolons', 'Counting brackets', 'Balancing parentheses', 'Sharpening pencils', 'Warming up', 'Stretching first', 'Cracking knuckles',
  'Reticulating splines', 'Defragmenting thoughts', 'Compiling thoughts', 'Linking neurons', 'Spinning up', 'Booting brain', 'Loading genius', 'Summoning focus',
  'Channeling wisdom', 'Gathering wits', 'Collecting thoughts', 'Sorting it out', 'Figuring it out', 'Working the angles', 'Weighing options', 'Scheming gently',
  'Plotting', 'Hatching a plan', 'Drafting a plan', 'Sketching it out', 'Doodling diagrams', 'Whiteboarding', 'Brainstorming', 'Thinking cap on',
  'Deep in thought', 'Lost in thought', 'In the zone', 'Getting cozy', 'Rolling up sleeves', 'Making tea', 'Brewing coffee', 'Pouring espresso',
  'Grinding beans', 'Steeping', 'Simmering', 'Marinating', 'Slow cooking', 'Kneading the dough', 'Letting it rise', 'Proofing',
  'Baking', 'Taste testing', 'Seasoning lightly', 'Stirring the pot', 'Whisking', 'Folding gently', 'Plating up', 'Garnishing',
  'Tinkering', 'Fiddling', 'Puttering', 'Pottering about', 'Futzing', 'Jiggling the handle', 'Tightening screws', 'Oiling gears',
  'Turning cranks', 'Pulling levers', 'Flipping switches', 'Twiddling knobs', 'Adjusting dials', 'Calibrating', 'Fine-tuning', 'Recalibrating',
  'Spelunking the codebase', 'Exploring caves', 'Mapping the maze', 'Following breadcrumbs', 'Chasing rabbits', 'Down the rabbit hole', 'Following the thread', 'Pulling threads',
  'Reading the tea leaves', 'Consulting the stars', 'Gazing into the abyss', 'Peering closely', 'Squinting at it', 'Looking sideways', 'Zooming in', 'Zooming out',
  'Taking it apart', 'Putting it together', 'Assembling pieces', 'Snapping together', 'Fitting puzzle pieces', 'Finding the edge pieces', 'Sorting by color', 'Solving the puzzle',
  'Cracking the code', 'Decoding', 'Deciphering', 'Translating gremlin', 'Reading the runes', 'Studying the scrolls', 'Unrolling scrolls', 'Dusting off tomes',
  'Hitting the books', 'Cramming', 'Taking notes', 'Highlighting things', 'Underlining twice', 'Dog-earing pages', 'Bookmarking', 'Citing sources',
  'Thinking hard', 'Thinking harder', 'Thinking very hard', 'Big brain time', 'Galaxy brain mode', 'Neurons firing', 'Synapses snapping', 'Gears turning',
  'Wheels spinning', 'Hamsters running', 'Feeding the hamsters', 'Waking the hamsters', 'Caffeinating', 'Hydrating', 'Taking a breath', 'Counting to ten',
  'Meditating', 'Finding zen', 'Centering', 'Breathing deeply', 'Contemplating', 'Philosophizing', 'Musing', 'Daydreaming productively',
  'Wondering', 'Imagining', 'Envisioning', 'Dreaming in code', 'Speaking fluent JSON', 'Thinking in loops', 'Recursing', 'Recursing again',
  'Iterating', 'Looping back', 'Circling back', 'Doubling back', 'Retracing steps', 'Backtracking', 'Rewinding the tape', 'Fast-forwarding',
  'Shaking the eight ball', 'Rolling the dice', 'Drawing cards', 'Flipping coins', 'Spinning the wheel', 'Pulling a rabbit', 'Waving the wand', 'Casting spells',
  'Mixing potions', 'Stirring the cauldron', 'Consulting the oracle', 'Asking the wizard', 'Polishing the crystal ball', 'Brewing magic', 'Conjuring', 'Enchanting',
  'Alchemizing', 'Transmuting', 'Distilling', 'Refining', 'Smelting ideas', 'Forging ahead', 'Hammering it out', 'Tempering steel',
  'Whittling', 'Carving', 'Sculpting', 'Chiseling details', 'Sanding edges', 'Buffing', 'Lacquering', 'Varnishing',
  'Knitting', 'Crocheting', 'Weaving threads', 'Stitching together', 'Darning socks', 'Quilting', 'Embroidering', 'Hemming',
  'Gardening', 'Watering seeds', 'Pruning branches', 'Pulling weeds', 'Planting ideas', 'Composting', 'Tending the garden', 'Harvesting',
  'Fishing for answers', 'Casting a line', 'Reeling it in', 'Baiting the hook', 'Waiting for a bite', 'Netting results', 'Trawling', 'Dredging',
  'Digging deep', 'Excavating', 'Unearthing', 'Mining for gold', 'Panning for gold', 'Striking gold', 'Prospecting', 'Surveying',
  'Charting a course', 'Setting sail', 'Hoisting sails', 'Trimming the sails', 'Navigating', 'Reading the map', 'Checking the compass', 'Finding north',
  'Climbing', 'Scaling the summit', 'Base camping', 'Roping up', 'Taking the scenic route', 'Hiking', 'Trekking', 'Wandering purposefully',
  'Moseying', 'Sauntering', 'Strolling', 'Ambling', 'Shuffling along', 'Tiptoeing', 'Skipping ahead', 'Hopscotching',
  'Somersaulting', 'Cartwheeling', 'Juggling', 'Plate spinning', 'Tightrope walking', 'Unicycling', 'Doing a little dance', 'Moonwalking',
  'Humming along', 'Whistling', 'Tapping a foot', 'Drumming fingers', 'Composing', 'Orchestrating', 'Conducting', 'Harmonizing',
  'Riffing', 'Jamming', 'Improvising', 'Freestyling', 'Remixing', 'Beatboxing', 'Tuning up', 'Finding the groove',
  'Building castles', 'Stacking blocks', 'Laying bricks', 'Pouring foundations', 'Raising the roof', 'Framing it up', 'Measuring twice', 'Cutting once',
  'Sweeping up', 'Tidying up', 'Dusting off', 'Mopping floors', 'Decluttering', 'Spring cleaning', 'Folding laundry', 'Sparking joy',
  'Unboxing', 'Unwrapping', 'Peeling layers', 'Opening the onion', 'Untying knots', 'Detangling', 'Unknotting', 'Straightening out',
  'Reasoning', 'Deducing', 'Inferring', 'Hypothesizing', 'Theorizing', 'Investigating', 'Sleuthing', 'Detective mode',
  'Following clues', 'Dusting for prints', 'Interviewing suspects', 'Elementary, dear user', 'Connecting the evidence', 'Cracking the case', 'Magnifying glass out', 'On the case',
  'Beep boop', 'Bleep bloop', 'Whirring', 'Buzzing', 'Humming', 'Clicking and clacking', 'Ticking along', 'Purring',
  'Doing the math', 'Crunching numbers', 'Carrying the one', 'Long division', 'Counting sheep', 'Counting on fingers', 'Adding it up', 'Running the numbers',
  'Vibing', 'Locking in', 'Cooking', "Let him cook", 'Grinding', 'Leveling up', 'Speedrunning', 'Respawning',
  'Loading the next level', 'Saving progress', 'Checkpointing', 'Collecting coins', 'Questing', 'Side questing', 'Grinding XP', 'Rolling for initiative',
  'Consulting the manual', 'RTFM-ing', 'Reading the docs', 'Skimming the docs', 'Grepping', 'Searching high and low', 'Looking under rugs', 'Checking couch cushions',
  'Finding the needle', 'Searching the haystack', 'Rummaging', 'Foraging', 'Scavenging', 'Treasure hunting', 'X marks the spot', 'Following the map',
  'Hmm', 'Hmmmm', 'Ooh, interesting', 'Aha, maybe', 'Wait a second', 'One moment', 'Just a sec', 'Almost got it',
  'Getting there', 'Nearly there', 'On it', 'Right on it', 'Working my magic', 'Doing the thing', 'Making it happen', 'Bringing it home',
];

let last = -1;
/** A phrase for this turn, never the one used last time. */
export function pickPhrase(random: () => number = Math.random): string {
  let i = Math.floor(random() * PHRASES.length);
  if (i === last) i = (i + 1) % PHRASES.length;
  last = i;
  return PHRASES[i]!;
}
