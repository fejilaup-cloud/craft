/**
 * Tests for GET /api/cron/aggregate-analytics
 *
 * Runs hourly and daily analytics aggregation concurrently via Promise.all.
 * Aggregations may partially fail (one succeeds, other rejects).
 *
 * Covers:
 *   - Authorization enforcement (CRON_SECRET present / absent)
 *   - Happy path: both aggregations succeed, response shape verified
 *   - Partial failure: one aggregation succeeds, other rejects → 500
 *   - Full failure: both aggregations fail → 500
 *   - Unauthenticated request returns 401
 *   - Response body matches documented { success, hourly, daily } contract
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockAggregate = vi.fn();

vi.mock('@/services/analytics-aggregation.service', () => ({
    analyticsAggregationService: {
        aggregate: mockAggregate,
    },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(authHeader?: string) {
    const headers: Record<string, string> = {};
    if (authHeader !== undefined) {
        headers['authorization'] = authHeader;
    }
    return new NextRequest('http://localhost/api/cron/aggregate-analytics', { headers });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/cron/aggregate-analytics', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        delete process.env.CRON_SECRET;
        mockAggregate.mockResolvedValue({ bucketsWritten: 0 });
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
            expect(mockAggregate).not.toHaveBeenCalled();
        });

        it('returns 401 when Authorization header has an incorrect Bearer token', async () => {
            process.env.CRON_SECRET = 'super-secret';
            const { GET } = await import('./route');
            const res = await GET(makeRequest('Bearer wrong-token'));
            expect(res.status).toBe(401);
            expect(mockAggregate).not.toHaveBeenCalled();
        });

        it('proceeds when Authorization header matches CRON_SECRET exactly', async () => {
            process.env.CRON_SECRET = 'super-secret';
            mockAggregate
                .mockResolvedValueOnce({ bucketsWritten: 12 })
                .mockResolvedValueOnce({ bucketsWritten: 4 });
            const { GET } = await import('./route');
            const res = await GET(makeRequest('Bearer super-secret'));
            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.success).toBe(true);
            expect(body.hourly.bucketsWritten).toBe(12);
            expect(body.daily.bucketsWritten).toBe(4);
        });

        it('skips auth check and proceeds when CRON_SECRET is not configured', async () => {
            mockAggregate
                .mockResolvedValueOnce({ bucketsWritten: 5 })
                .mockResolvedValueOnce({ bucketsWritten: 2 });
            const { GET } = await import('./route');
            const res = await GET(makeRequest());
            expect(res.status).toBe(200);
            expect((await res.json()).success).toBe(true);
        });
    });

    // ── Happy path ─────────────────────────────────────────────────────────────

    describe('happy path: both aggregations succeed', () => {
        it('returns 200 with success:true when both 1h and 24h aggregations succeed', async () => {
            mockAggregate
                .mockResolvedValueOnce({ bucketsWritten: 10 })
                .mockResolvedValueOnce({ bucketsWritten: 8 });
            const { GET } = await import('./route');
            const res = await GET(makeRequest());
            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.success).toBe(true);
            expect(body).toHaveProperty('hourly');
            expect(body).toHaveProperty('daily');
        });

        it('calls aggregate with correct granularities in parallel', async () => {
            mockAggregate
                .mockResolvedValueOnce({ bucketsWritten: 3 })
                .mockResolvedValueOnce({ bucketsWritten: 1 });
            const { GET } = await import('./route');
            await GET(makeRequest());
            expect(mockAggregate).toHaveBeenCalledTimes(2);
            expect(mockAggregate).toHaveBeenCalledWith('1h');
            expect(mockAggregate).toHaveBeenCalledWith('24h');
        });

        it('response includes bucketsWritten from each aggregation', async () => {
            mockAggregate
                .mockResolvedValueOnce({ bucketsWritten: 25 })
                .mockResolvedValueOnce({ bucketsWritten: 7 });
            const { GET } = await import('./route');
            const res = await GET(makeRequest());
            const body = await res.json();
            expect(body.hourly.bucketsWritten).toBe(25);
            expect(body.daily.bucketsWritten).toBe(7);
        });

        it('handles zero buckets written correctly', async () => {
            mockAggregate
                .mockResolvedValueOnce({ bucketsWritten: 0 })
                .mockResolvedValueOnce({ bucketsWritten: 0 });
            const { GET } = await import('./route');
            const res = await GET(makeRequest());
            const body = await res.json();
            expect(body.hourly.bucketsWritten).toBe(0);
            expect(body.daily.bucketsWritten).toBe(0);
        });
    });

    // ── Partial failure: one aggregation fails ──────────────────────────────────

    describe('partial failure: one aggregation fails', () => {
        it('returns 500 when 1h aggregation fails and 24h succeeds', async () => {
            mockAggregate
                .mockRejectedValueOnce(new Error('1h aggregation failed'))
                .mockResolvedValueOnce({ bucketsWritten: 5 });
            const { GET } = await import('./route');
            const res = await GET(makeRequest());
            expect(res.status).toBe(500);
            expect((await res.json()).error).toContain('1h aggregation failed');
        });

        it('returns 500 when 24h aggregation fails and 1h succeeds', async () => {
            mockAggregate
                .mockResolvedValueOnce({ bucketsWritten: 10 })
                .mockRejectedValueOnce(new Error('24h aggregation failed'));
            const { GET } = await import('./route');
            const res = await GET(makeRequest());
            expect(res.status).toBe(500);
            expect((await res.json()).error).toContain('24h aggregation failed');
        });

        it('returns the full error message when an Error is thrown', async () => {
            mockAggregate
                .mockRejectedValueOnce(new Error('Aggregation service error'));
            const { GET } = await import('./route');
            const res = await GET(makeRequest());
            const body = await res.json();
            expect(body.error).toBe('Aggregation service error');
        });
    });

    // ── Full failure: both aggregations fail ────────────────────────────────────

    describe('full failure: both aggregations fail', () => {
        it('returns 500 when both aggregations fail', async () => {
            mockAggregate
                .mockRejectedValueOnce(new Error('1h failed'))
                .mockRejectedValueOnce(new Error('24h failed'));
            const { GET } = await import('./route');
            const res = await GET(makeRequest());
            expect(res.status).toBe(500);
            // Promise.all rejects with the first error
            expect((await res.json()).error).toContain('1h failed');
        });

        it('reports first rejection error when Promise.all rejects', async () => {
            const error1 = new Error('First error');
            const error2 = new Error('Second error');
            mockAggregate
                .mockRejectedValueOnce(error1)
                .mockRejectedValueOnce(error2);
            const { GET } = await import('./route');
            const res = await GET(makeRequest());
            const body = await res.json();
            expect(body.error).toContain('First error');
        });
    });

    // ── Error message handling ──────────────────────────────────────────────────

    describe('error message handling', () => {
        it('returns error message from thrown Error object', async () => {
            mockAggregate.mockRejectedValueOnce(new Error('Custom error message'));
            const { GET } = await import('./route');
            const res = await GET(makeRequest());
            const body = await res.json();
            expect(body.error).toBe('Custom error message');
        });

        it('returns error message when error object has message property', async () => {
            mockAggregate.mockRejectedValueOnce({ message: 'Error from object' });
            const { GET } = await import('./route');
            const res = await GET(makeRequest());
            const body = await res.json();
            expect(body.error).toBe('Error from object');
        });

        it('logs the error to console.error', async () => {
            const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
            mockAggregate.mockRejectedValueOnce(new Error('Test error'));
            const { GET } = await import('./route');
            await GET(makeRequest());
            expect(spy).toHaveBeenCalledWith(
                'Analytics aggregation failed:',
                expect.any(Error)
            );
            spy.mockRestore();
        });
    });

    // ── Response shape contract ────────────────────────────────────────────────

    describe('response shape contract', () => {
        it('response has success, hourly, and daily properties on success', async () => {
            mockAggregate
                .mockResolvedValueOnce({ bucketsWritten: 10 })
                .mockResolvedValueOnce({ bucketsWritten: 5 });
            const { GET } = await import('./route');
            const res = await GET(makeRequest());
            const body = await res.json();
            expect(Object.keys(body).sort()).toEqual(['daily', 'hourly', 'success']);
        });

        it('hourly and daily objects have bucketsWritten property', async () => {
            mockAggregate
                .mockResolvedValueOnce({ bucketsWritten: 3 })
                .mockResolvedValueOnce({ bucketsWritten: 2 });
            const { GET } = await import('./route');
            const res = await GET(makeRequest());
            const body = await res.json();
            expect(body.hourly).toHaveProperty('bucketsWritten');
            expect(body.daily).toHaveProperty('bucketsWritten');
            expect(typeof body.hourly.bucketsWritten).toBe('number');
            expect(typeof body.daily.bucketsWritten).toBe('number');
        });

        it('failure response has only error property', async () => {
            mockAggregate.mockRejectedValueOnce(new Error('Failed'));
            const { GET } = await import('./route');
            const res = await GET(makeRequest());
            const body = await res.json();
            expect(body).toHaveProperty('error');
            expect(body).not.toHaveProperty('success');
            expect(body).not.toHaveProperty('hourly');
            expect(body).not.toHaveProperty('daily');
        });
    });
});
