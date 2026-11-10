/**
 * The story workflow is declared once (src/lib/workflow.ts). The web UI keeps its own copy for
 * instant feedback; this contract test fails if the two ever disagree.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEstimable, nextActions, STORY_STATES, STORY_TYPES, TYPE_RULES, validateWorkflow } from '../src/lib/workflow.js';
import { storyPoints } from '../src/lib/iterations.js';
import * as web from '../../web/src/util.js';

test('workflow table is internally consistent', () => {
  assert.deepEqual(validateWorkflow(), []);
});

test('web UI allowed states match the server', () => {
  for (const type of STORY_TYPES) assert.deepEqual(web.STATES_FOR[type], [...TYPE_RULES[type].states], type);
});

test('web UI workflow buttons match the server for every type and state', () => {
  for (const type of STORY_TYPES) {
    for (const state of STORY_STATES) {
      assert.deepEqual(web.stateActions({ story_type: type, current_state: state }), nextActions(type, state), `${type}/${state}`);
    }
  }
});

test('web UI estimation and points rules match the server', () => {
  for (const type of STORY_TYPES) {
    for (const setting of [true, false]) {
      const p = { bugs_and_chores_are_estimatable: setting };
      assert.equal(web.isEstimatable(type, p), isEstimable(type, setting), `${type} estimable (setting=${setting})`);
      for (const estimate of [null, 0, 3]) {
        assert.equal(web.storyPoints({ story_type: type, estimate }, p), storyPoints({ story_type: type, estimate }, p), `${type} points ${estimate}`);
      }
    }
  }
});
