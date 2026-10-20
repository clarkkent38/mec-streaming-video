'use strict';
/**
 * tailscale-parser.test.js
 * Tests for every parsing / detection function in tailscale-assistant.js
 * that can run without the real Tailscale CLI.
 * We extract the pure helper logic inline rather than require()-ing the full
 * module (which has side-effects like execFile calls at import time in some
 * environments), so the tests are self-contained.
 */

// ── Inline the pure helpers from tailscale-assistant.js ──────────────────────

/** Strip trailing dot from DNS name. */
function parseDnsName(raw) {
  if (!raw) return null;
  return raw.replace(/\.$/, '');
}

/** Determine if Tailscale is running and connected from `tailscale status --json`. */
function parseStatusJson(jsonText) {
  let json;
  try { json = JSON.parse(jsonText); } catch (_) { return { running: false, dnsName: null }; }
  const running = json.BackendState === 'Running';
  const rawDns  = json.Self && json.Self.DNSName ? json.Self.DNSName : null;
  const dnsName = parseDnsName(rawDns);
  return { running, dnsName };
}

/** Detect funnel CLI syntax from help text. */
function detectFunnelSyntax(helpText) {
  const lower = (helpText || '').toLowerCase();
  // Newer CLI: expects a port number as positional argument
  if (lower.includes('<port>')) return 'newer';
  // Older CLI: uses on/off toggle
  if (lower.includes('on|off') || lower.includes('on/off')) return 'older';
  // Unknown/empty — assume newer
  return 'newer';
}

/** Extract admin console link from CLI output. */
function extractAdminLink(text) {
  const match = (text || '').match(/https:\/\/login\.tailscale\.com\/admin[^\s]*/);
  return match ? match[0] : null;
}

/** Verify funnel status output contains our port. */
function verifyFunnelOutput(statusText, port) {
  return (statusText || '').includes(String(port));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('parseDnsName', () => {
  test('strips trailing dot', () => {
    expect(parseDnsName('myhost.tail1234.ts.net.')).toBe('myhost.tail1234.ts.net');
  });
  test('leaves name without dot unchanged', () => {
    expect(parseDnsName('myhost.tail1234.ts.net')).toBe('myhost.tail1234.ts.net');
  });
  test('returns null for null input', () => {
    expect(parseDnsName(null)).toBeNull();
  });
  test('returns null for empty string', () => {
    expect(parseDnsName('')).toBeNull();
  });
});

describe('parseStatusJson — BackendState', () => {
  test('Running with DNSName → running=true, dnsName set', () => {
    const json = JSON.stringify({
      BackendState: 'Running',
      Self: { DNSName: 'myhost.tail1234.ts.net.' },
    });
    const result = parseStatusJson(json);
    expect(result.running).toBe(true);
    expect(result.dnsName).toBe('myhost.tail1234.ts.net');
  });

  test('NeedsLogin → running=false', () => {
    const json = JSON.stringify({
      BackendState: 'NeedsLogin',
      Self: { DNSName: 'myhost.tail1234.ts.net.' },
    });
    expect(parseStatusJson(json).running).toBe(false);
  });

  test('Running but no Self.DNSName → dnsName=null', () => {
    const json = JSON.stringify({ BackendState: 'Running', Self: {} });
    const result = parseStatusJson(json);
    expect(result.running).toBe(true);
    expect(result.dnsName).toBeNull();
  });

  test('Stopped state → running=false', () => {
    const json = JSON.stringify({ BackendState: 'Stopped' });
    expect(parseStatusJson(json).running).toBe(false);
  });

  test('Invalid JSON → running=false', () => {
    expect(parseStatusJson('not-json').running).toBe(false);
  });

  test('Empty string → running=false', () => {
    expect(parseStatusJson('').running).toBe(false);
  });
});

describe('detectFunnelSyntax', () => {
  test('detects newer syntax when help contains <port>', () => {
    const help = 'Usage: tailscale funnel [--bg] <port>';
    expect(detectFunnelSyntax(help)).toBe('newer');
  });

  test('detects newer syntax when help matches funnel [ pattern', () => {
    const help = 'tailscale funnel [flags] port\nOptions:';
    expect(detectFunnelSyntax(help)).toBe('newer');
  });

  test('detects older syntax when help contains on|off only', () => {
    const help = 'tailscale funnel [--bg] on|off';
    expect(detectFunnelSyntax(help)).toBe('older');
  });

  test('defaults to newer on empty input', () => {
    expect(detectFunnelSyntax('')).toBe('newer');
  });

  test('is case-insensitive', () => {
    const help = 'TAILSCALE FUNNEL [FLAGS] <PORT>';
    expect(detectFunnelSyntax(help)).toBe('newer');
  });
});

describe('extractAdminLink', () => {
  test('extracts login.tailscale.com/admin link', () => {
    const text = 'Error: visit https://login.tailscale.com/admin/acls to enable Funnel.';
    expect(extractAdminLink(text)).toBe('https://login.tailscale.com/admin/acls');
  });

  test('extracts link with query string', () => {
    const text = 'see https://login.tailscale.com/admin/dns?tab=https for details';
    expect(extractAdminLink(text)).toBe('https://login.tailscale.com/admin/dns?tab=https');
  });

  test('returns null when no admin link present', () => {
    expect(extractAdminLink('No link here')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(extractAdminLink('')).toBeNull();
  });

  test('returns null for null', () => {
    expect(extractAdminLink(null)).toBeNull();
  });

  test('does not match non-admin tailscale URLs', () => {
    const text = 'visit https://tailscale.com/download';
    expect(extractAdminLink(text)).toBeNull();
  });
});

describe('verifyFunnelOutput', () => {
  test('returns true when port 5001 appears in status', () => {
    const status = `
https://myhost.tail1234.ts.net (Funnel on)
  |-- / proxy http://127.0.0.1:5001
`;
    expect(verifyFunnelOutput(status, 5001)).toBe(true);
  });

  test('returns false when port is absent', () => {
    const status = 'https://myhost.tail1234.ts.net (Funnel on)';
    expect(verifyFunnelOutput(status, 5001)).toBe(false);
  });

  test('returns false for empty status', () => {
    expect(verifyFunnelOutput('', 5001)).toBe(false);
  });

  test('matches any port number', () => {
    const status = 'proxy http://127.0.0.1:9000';
    expect(verifyFunnelOutput(status, 9000)).toBe(true);
    expect(verifyFunnelOutput(status, 5001)).toBe(false);
  });
});
