import assert from 'node:assert/strict';
import test from 'node:test';
import { initialOnboardingState } from '../src/types.ts';

test('only fresh installs start onboarding automatically', () => {
  assert.equal(initialOnboardingState(null), 'pending');
  assert.equal(initialOnboardingState({}), 'done');
  assert.equal(initialOnboardingState({ apiKey: 'existing' }), 'done');
});

test('saved onboarding state is preserved', () => {
  assert.equal(initialOnboardingState({ onboardingState: 'pending' }), 'pending');
  assert.equal(initialOnboardingState({ onboardingState: 'done' }), 'done');
});
