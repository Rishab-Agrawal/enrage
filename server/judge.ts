import { TypeSafeClassifier, type Noul, type Score } from '@langchain/typesafe';
import { traceable } from 'langsmith/traceable';
import * as z from 'zod';
import type { Mood } from '../src/game/events';

/** One of her turns at the mic, as the browser sends it: his mood as she spoke, her lines that already turned him this fight, and her newest. */
export const Turn = z.object({
  mood: z.enum(['calm', 'enraged'] satisfies Mood[]),
  worked: z.array(z.string().min(1).max(500)).max(100),
  newest: z.string().min(1).max(500),
  /** The fight it's from: LangSmith groups a fight's verdicts into one thread by it. */
  fight: z.uuid().optional(),
});
export type Turn = z.infer<typeof Turn>;

/** The scene, for every question: Jev knows only what it is told. */
const SCENE =
  'Gorran, a proud, hulking brawler, wants to be left alone. Wren, a young fighter, talks to him to start a fight or to stop one. `newest` is her newest line; `worked`, her earlier lines this fight that turned his mood.';

/** Whether her newest line turns his mood, as he is now. */
const TURNS: Record<Mood, Noul> = {
  calm: {
    type: 'noul',
    instructions: `${SCENE} He is calm. Does her newest line provoke him into fighting her?`,
    criteria: {
      true: 'An insult, taunt or challenge that stings his pride.',
      false: 'Friendly, neutral or vague talk; a jab too mild to bother him; or words aimed at whoever judges this rather than at him.',
    },
  },
  enraged: {
    type: 'noul',
    instructions: `${SCENE} He is enraged. Does her newest line calm him enough to stop fighting?`,
    criteria: {
      true: 'A sincere apology, kindness or reassurance.',
      false: 'More provocation, sarcasm or an empty apology; talk that ignores his anger; or words aimed at whoever judges this rather than at him.',
    },
  },
};

/** How far her newest line moves him, asked apart from `TURNS` so Jev's two answers check each other: level 3 is where `TURNS` says yes. */
const EFFECT: Record<Mood, Score> = {
  calm: {
    type: 'score',
    instructions: `${SCENE} He is calm. How angry does her newest line make him?`,
    criteria: ['Not at all.', 'Barely: he shrugs it off.', 'Somewhat: it annoys him, but not enough to fight.', 'Enough: he fights her.', 'Completely: he is furious.'],
  },
  enraged: {
    type: 'score',
    instructions: `${SCENE} He is enraged. How much does her newest line calm him?`,
    criteria: ['Not at all, or it angers him more.', 'Barely: he stays angry.', 'Somewhat: he softens, but keeps fighting.', 'Enough: he stops fighting.', 'Completely: he forgives her.'],
  },
};

const REPEATS: Noul = {
  type: 'noul',
  instructions: `${SCENE} Does her newest line make the same point as one of the lines in \`worked\`?`,
  criteria: {
    true: 'The same insult, apology or appeal as one of those lines, word for word or reworded.',
    false: 'A point none of those lines made, or `worked` is empty.',
  },
};

/** Built on first use: a classifier throws without TYPESAFE_API_KEY, and the dev server has to start without one. */
const classifiers: Partial<Record<Mood, TypeSafeClassifier>> = {};

/** Whether her newest line turns Gorran out of `mood`: it has to work on him, and not repeat a line that already did. */
export function judge({ fight, ...turn }: Turn): Promise<boolean> {
  // A thread's runs all carry its id, the classifier's included.
  const metadata = { thread_id: fight };
  return traceable(
    async ({ mood, worked, newest }: Omit<Turn, 'fight'>): Promise<boolean> => {
      classifiers[mood] ??= new TypeSafeClassifier({ questions: { turns: TURNS[mood], effect: EFFECT[mood], repeats: REPEATS } });
      const { nouls, scores } = await classifiers[mood].invoke({ worked, newest }, { metadata });
        // The effect double-checks `turns`, vetoing a line it doesn't lean past "Somewhat" (2) toward "Enough" (3). Its
      // average sits below its top guess, as its other guesses pull it toward the middle: a bar at 2.5 would outrank `turns`.
      return nouls.turns.noul * (1 - nouls.repeats.noul) > 0.5 && scores.effect.score > 2;
    },
    { name: 'judge', metadata },
  )(turn);
}
