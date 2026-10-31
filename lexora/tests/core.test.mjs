import assert from 'node:assert/strict';
import {
  qualifiesToUnlock,
  unlockedLevelsAfterFinal,
  shouldUnlockLevel,
  scorePercentage,
  nextLevel,
  progressKey
} from '../js/core.js';

assert.equal(scorePercentage(89, 100), 89);
assert.equal(scorePercentage(90, 100), 90);
assert.equal(scorePercentage(95, 100), 95);
assert.equal(scorePercentage(100, 100), 100);
assert.equal(qualifiesToUnlock(89), false, '89% must not unlock the next level');
assert.equal(qualifiesToUnlock(90), true, '90% must unlock the next level');
assert.equal(qualifiesToUnlock(91), true);
assert.equal(qualifiesToUnlock(95), true);
assert.equal(qualifiesToUnlock(100), true, '100% must unlock the next level');
assert.equal(shouldUnlockLevel(89, 'A1', ['A1']), null);
assert.equal(shouldUnlockLevel(90, 'A1', ['A1']), 'A2');
assert.equal(shouldUnlockLevel(95, 'A2', ['A1','A2']), 'B1');
assert.equal(shouldUnlockLevel(100, 'B1', ['A1','A2','B1']), 'B2');
assert.deepEqual(unlockedLevelsAfterFinal(89, 'A1', ['A1']), ['A1']);
assert.deepEqual(unlockedLevelsAfterFinal(90, 'A1', ['A1']), ['A1','A2']);
assert.deepEqual(unlockedLevelsAfterFinal(91, 'A1', ['A1']), ['A1','A2']);
assert.deepEqual(unlockedLevelsAfterFinal(95, 'A2', ['A1','A2']), ['A1','A2','B1']);
assert.deepEqual(unlockedLevelsAfterFinal(100, 'B1', ['A1','A2','B1']), ['A1','A2','B1','B2']);
assert.deepEqual(unlockedLevelsAfterFinal(89, 'A1', ['A1','A2']), ['A1','A2'], 'a failed retry never re-locks an already-open level');
assert.deepEqual(
  unlockedLevelsAfterFinal(100, 'A1', ['A1','A2','B1']),
  ['A1','A2','B1'],
  'an already-open level stays open and is not appended again'
);
assert.deepEqual(unlockedLevelsAfterFinal(100, 'B2', ['A1','A2','B1','B2']), ['A1','A2','B1','B2'], 'the last level never creates C1');
assert.equal(nextLevel('B2'), null, 'the supplied Oxford source ends at B2; no C1 is created');
assert.equal(progressKey('ox-0001','A1'), 'ox-0001::A1');
console.log('PASS: 23 core progression assertions, including app state transitions at 89/90/95/100.');
