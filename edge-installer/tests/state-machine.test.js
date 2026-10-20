'use strict';
/**
 * state-machine.test.js
 * Tests state transitions using a lightweight mock of the state machine logic.
 * We don't require the real state-machine.js (it imports Electron modules),
 * so we extract and re-implement the pure transition logic here.
 */

const STATES = {
  SETUP: 'SETUP', LOCAL_ONLY: 'LOCAL_ONLY', PUBLIC_PENDING: 'PUBLIC_PENDING',
  LIVE: 'LIVE', DEGRADED: 'DEGRADED', OFFLINE: 'OFFLINE',
};

/**
 * Pure function: determine state given conditions.
 * Mirrors the logic in state-machine.js _evaluate() and _processPollResult().
 */
function evalState({ configComplete, agentRunning, mode, publicUrl }) {
  if (!configComplete)              return STATES.SETUP;
  if (!agentRunning)                return STATES.OFFLINE;
  if (mode === 'public' && !publicUrl) return STATES.LOCAL_ONLY;
  return STATES.PUBLIC_PENDING;   // will become LIVE after poll confirms it
}

/**
 * Pure function: determine state from orchestrator poll result.
 */
function pollTransition({ currentState, found, agentRunning, degradedCount }) {
  if (!agentRunning) return { state: STATES.OFFLINE, degradedCount: 0 };
  if (!found) {
    const newCount = degradedCount + 1;
    return {
      state: newCount >= 3 ? STATES.DEGRADED : currentState,
      degradedCount: newCount,
    };
  }
  const isOnline = found.edgeStatus === 'online' || found.status === 'UP';
  const hasRtt   = found.measuredLatencyMs !== null && found.measuredLatencyMs !== undefined;
  if (isOnline && hasRtt)   return { state: STATES.LIVE,           degradedCount: 0 };
  if (isOnline && !hasRtt)  return { state: STATES.PUBLIC_PENDING, degradedCount: 0 };
  const newCount = degradedCount + 1;
  return {
    state: newCount >= 2 ? STATES.DEGRADED : currentState,
    degradedCount: newCount,
  };
}

// ── evalState tests ───────────────────────────────────────────────────────────

describe('evalState — initial state evaluation', () => {
  test('SETUP when config incomplete', () => {
    expect(evalState({ configComplete: false, agentRunning: false, mode: 'public', publicUrl: null }))
      .toBe(STATES.SETUP);
  });

  test('OFFLINE when config complete but agent not running', () => {
    expect(evalState({ configComplete: true, agentRunning: false, mode: 'public', publicUrl: null }))
      .toBe(STATES.OFFLINE);
  });

  test('LOCAL_ONLY when public mode but no Funnel URL', () => {
    expect(evalState({ configComplete: true, agentRunning: true, mode: 'public', publicUrl: null }))
      .toBe(STATES.LOCAL_ONLY);
  });

  test('PUBLIC_PENDING when public mode and Funnel URL set', () => {
    expect(evalState({ configComplete: true, agentRunning: true, mode: 'public', publicUrl: 'https://x.ts.net' }))
      .toBe(STATES.PUBLIC_PENDING);
  });

  test('PUBLIC_PENDING in LAN mode (no Funnel required)', () => {
    expect(evalState({ configComplete: true, agentRunning: true, mode: 'lan', publicUrl: null }))
      .toBe(STATES.PUBLIC_PENDING);
  });
});

// ── pollTransition tests ──────────────────────────────────────────────────────

describe('pollTransition — orchestrator poll result', () => {
  test('LIVE when online + measuredLatencyMs set', () => {
    const edge = { edgeId: 'x', edgeStatus: 'online', measuredLatencyMs: 45 };
    const result = pollTransition({ currentState: STATES.PUBLIC_PENDING, found: edge, agentRunning: true, degradedCount: 0 });
    expect(result.state).toBe(STATES.LIVE);
    expect(result.degradedCount).toBe(0);
  });

  test('LIVE when status=UP (alternate field)', () => {
    const edge = { edgeId: 'x', status: 'UP', measuredLatencyMs: 20 };
    expect(pollTransition({ currentState: STATES.PUBLIC_PENDING, found: edge, agentRunning: true, degradedCount: 0 }).state)
      .toBe(STATES.LIVE);
  });

  test('PUBLIC_PENDING when online but measuredLatencyMs=null (still probing)', () => {
    const edge = { edgeId: 'x', edgeStatus: 'online', measuredLatencyMs: null };
    expect(pollTransition({ currentState: STATES.PUBLIC_PENDING, found: edge, agentRunning: true, degradedCount: 0 }).state)
      .toBe(STATES.PUBLIC_PENDING);
  });

  test('PUBLIC_PENDING when online but measuredLatencyMs=undefined', () => {
    const edge = { edgeId: 'x', edgeStatus: 'online' };
    expect(pollTransition({ currentState: STATES.PUBLIC_PENDING, found: edge, agentRunning: true, degradedCount: 0 }).state)
      .toBe(STATES.PUBLIC_PENDING);
  });

  test('DEGRADED after 2 consecutive offline polls', () => {
    const edge = { edgeId: 'x', edgeStatus: 'offline', measuredLatencyMs: null };
    const r1 = pollTransition({ currentState: STATES.LIVE,    found: edge, agentRunning: true, degradedCount: 0 });
    const r2 = pollTransition({ currentState: r1.state, found: edge, agentRunning: true, degradedCount: r1.degradedCount });
    expect(r2.state).toBe(STATES.DEGRADED);
  });

  test('DEGRADED after 3 consecutive not-found polls', () => {
    let s = STATES.PUBLIC_PENDING, c = 0;
    for (let i = 0; i < 3; i++) {
      const r = pollTransition({ currentState: s, found: null, agentRunning: true, degradedCount: c });
      s = r.state; c = r.degradedCount;
    }
    expect(s).toBe(STATES.DEGRADED);
  });

  test('degradedCount resets to 0 on LIVE', () => {
    const edge = { edgeId: 'x', edgeStatus: 'online', measuredLatencyMs: 30 };
    const result = pollTransition({ currentState: STATES.DEGRADED, found: edge, agentRunning: true, degradedCount: 5 });
    expect(result.state).toBe(STATES.LIVE);
    expect(result.degradedCount).toBe(0);
  });

  test('OFFLINE immediately when agent not running', () => {
    const edge = { edgeId: 'x', edgeStatus: 'online', measuredLatencyMs: 10 };
    const result = pollTransition({ currentState: STATES.LIVE, found: edge, agentRunning: false, degradedCount: 0 });
    expect(result.state).toBe(STATES.OFFLINE);
  });
});
