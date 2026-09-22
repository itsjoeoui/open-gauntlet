import type { Problem, TestCase, TestSuite } from '@/types';

/** Collect regression tests through the selected level, with stable level labels. */
export function getTestsThroughLevel(problem: Pick<Problem, 'levels'>, currentLevel: number): TestSuite & { superseded: TestCase[] } {
  const tests: TestSuite & { superseded: TestCase[] } = { visible: [], hidden: [], superseded: [] };
  const levels = problem.levels
    .filter((level) => level.level <= currentLevel)
    .sort((a, b) => a.level - b.level);

  for (const level of levels) {
    for (const visibility of ['visible', 'hidden'] as const) {
      for (const test of level.testCases[visibility]) {
        const labeledTest = { ...test, name: `L${level.level}: ${test.name}` };
        if (test.supersededAtLevel != null && currentLevel >= test.supersededAtLevel) {
          tests.superseded.push(labeledTest);
        } else {
          tests[visibility].push(labeledTest);
        }
      }
    }
  }

  return tests;
}
