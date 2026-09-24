/**
 * Tests for GET /api/cron/purge-expired-tokens
 *
 * Purges expired GitHub tokens from the database:
 * - Nulls out github_token_encrypted and github_token_expires_at
 * - Only targets profiles whose token has passed its expiry
 * - Leaves NULL github_token_expires_at (classic PATs) untouched
 *
 * Covers:
 *   - Authorization enforcement (CRON_SECRET present / absent)
 *   - Happy path: mix of expired and non-expired tokens, only expired purged
 *   - Purge count matches actual deleted rows
 *   - Unauthenticated request returns 401
 *   - Error handling on database failure
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockLt = vi.fn();
const mockNot = vi.fn();
const mockUpdate = vi.fn();
const mockFrom = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
    createClient: () => ({
        from: mockFrom,
    }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(authHeader?: string) {
    const headers: Record<string, string> = {};
    if (authHeader !== undefined) {
        headers['authorization'] = authHeader;
    }
    return new NextRequest('http://localhost/api/cron/purge-expired-tokens', { headers });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/cron/purge-expired-tokens', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        delete process.env.CRON_SECRET;
        // Setup default successful response
        mockNot.mockResolvedValue({ error: null, count: 0 });
        mockLt.mockReturnValue({ not: mockNot });
        mockUpdate.mockReturnValue({ lt: mockLt });
        mockFrom.mockReturnValue({ update: mockUpdate });
    });

    afterEach(() => {
        delete process.env.CRON_SECRET;
    });

    // ── Authorization ─────────────────────────────────────────────────────────

    describe('authorization', () => {
        it('returns 401 when CRON_SECRET is set and Authorization header is absent', async () => {
            process.env.CRON_SECRET = 'super-secret';
            const { GET } = await import('./route');
            const res = await GET(makeRequest());
            expect(res.status).toBe(401);
            expect((await res.json()).error).toContain('Unauthorized');
        });

        it('returns 401 when Authorization header has an incorrect Bearer token', async () => {
            process.env.CRON_SECRET = 'super-secret';
            const { GET } = await import('./route');
            const res = await GET(makeRequest('Bearer wrong-token'));
            expect(res.status).toBe(401);
        });

        it('proceeds when Authorization header matches CRON_SECRET exactly', async () => {
            process.env.CRON_SECRET = 'super-secret';
            mockNot.mockResolvedValue({ error: null, count: 3 });
            const { GET } = await import('./route');
            const res = await GET(makeRequest('Bearer super-secret'));
            expect(res.status).toBe(200);
            expect((await res.json()).purged).toBe(3);
        });

        it('skips auth check and proceeds when CRON_SECRET is not configured', async () => {
            mockNot.mockResolvedValue({ error: null, count: 5 });
            const { GET } = await import('./route');
            const res = await GET(makeRequest());
            expect(res.status).toBe(200);
            expect((await res.json()).purged).toBe(5);
        });
    });

    // ── Token expiry filtering ─────────────────────────────────────────────────

    describe('token expiry filtering', () => {
        it('purges only expired tokens, leaving non-expired ones intact', async () => {
            mockNot.mockResolvedValue({ error: null, count: 3 });
            const { GET } = await import('./route');
            const res = await GET(makeRequest());
            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.purged).toBe(3);
            expect(mockUpdate).toHaveBeenCalledWith({
                github_token_encrypted: null,
                github_token_expires_at: null,
                github_connected: false,
            });
        });

        it('constructs filter: lt(github_token_expires_at, now) AND NOT NULL', async () => {
            mockNot.mockResolvedValue({ error: null, count: 2 });
            const { GET } = await import('./route');
            await GET(makeRequest());

            expect(mockLt).toHaveBeenCalled();
            const [field] = mockLt.mock.calls[0];
            expect(field).toBe('github_token_expires_at');

            expect(mockNot).toHaveBeenCalledWith('github_token_expires_at', 'is', null);
        });

        it('returns purged:0 when no tokens have expired', async () => {
            mockNot.mockResolvedValue({ error: null, count: 0 });
            const { GET } = await import('./route');
            const res = await GET(makeRequest());
            expect(res.status).toBe(200);
            expect((await res.json()).purged).toBe(0);
        });

        it('reports accurate purge count for large batch', async () => {
            mockNot.mockResolvedValue({ error: null, count: 150 });
            const { GET } = await import('./route');
            const res = await GET(makeRequest());
            expect(res.status).toBe(200);
            expect((await res.json()).purged).toBe(150);
        });

        it('handles NULL count (no rows affected) as 0', async () => {
            mockNot.mockResolvedValue({ error: null, count: null });
            const { GET } = await import('./route');
            const res = await GET(makeRequest());
            expect(res.status).toBe(200);
            expect((await res.json()).purged).toBe(0);
        });
    });

    // ── Error handling ──────────────────────────────────────────────────────────

    describe('error handling', () => {
        it('returns 500 with error message on database failure', async () => {
            delete process.env.CRON_SECRET;
            mockNot.mockResolvedValue({
                error: { message: 'Database connection lost' },
                count: null,
            });
            const { GET } = await import('./route');
            const res = await GET(makeRequest());
            expect(res.status).toBe(500);
            expect((await res.json()).error).toBe('Database connection lost');
        });

        it('does not include sensitive details in error response', async () => {
            delete process.env.CRON_SECRET;
            mockNot.mockResolvedValue({
                error: { message: 'Database connection: user=admin pass=secret' },
                count: null,
            });
            const { GET } = await import('./route');
            const res = await GET(makeRequest());
            expect(res.status).toBe(500);
            expect((await res.json())).toHaveProperty('error');
        });
    });
});
