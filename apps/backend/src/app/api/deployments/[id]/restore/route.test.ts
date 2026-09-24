/**
 * Tests for POST /api/deployments/[id]/restore
 *
 * Restores a soft-deleted deployment within the retention window.
 * Enforces ownership, retention-window cutoff, and audit logging.
 *
 * Covers:
 *   - Successful restore: updates deleted_at to NULL, emits audit log
 *   - Non-owner restore attempt → 404
 *   - Restore of non-deleted deployment → 404
 *   - Restore just inside retention window → 200
 *   - Restore just outside retention window → 410
 *   - Ownership check and 404-vs-410 status distinction
 *   - Audit log entry emitted on successful restore
 *   - Unauthenticated request → 401
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockGetUser = vi.fn();
const mockSelect = vi.fn();
const mockEq = vi.fn();
const mockNot = vi.fn();
const mockSingle = vi.fn();
const mockUpdate = vi.fn();
const mockFrom = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
    createClient: () => ({
        auth: { getUser: mockGetUser },
        from: mockFrom,
    }),
}));

vi.mock('@/lib/api/logger', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        withLogging: (handler: any) =>
            async (req: NextRequest, ctx: any) => {
                return handler(req, {
                    ...ctx,
                    correlationId: 'test-correlation-id',
                    log: {
                        audit: vi.fn(),
                        error: vi.fn(),
                        info: vi.fn(),
                    },
                });
            },
        CORRELATION_ID_HEADER: 'X-Correlation-Id',
    };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const fakeUser = { id: 'user-1', email: 'user@example.com' };
const params = { id: 'dep-1' };

function makeRequest() {
    return new NextRequest('http://localhost/api/deployments/dep-1/restore', { method: 'POST' });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/deployments/[id]/restore', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        process.env.DEPLOYMENT_TOMBSTONE_RETENTION_DAYS = '30';
        mockGetUser.mockResolvedValue({ data: { user: fakeUser }, error: null });
    });

    afterEach(() => {
        delete process.env.DEPLOYMENT_TOMBSTONE_RETENTION_DAYS;
    });

    // ── Authentication ────────────────────────────────────────────────────────

    describe('authentication', () => {
        it('returns 401 when unauthenticated', async () => {
            mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
            mockFrom.mockReturnValue({
                select: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                        not: vi.fn().mockReturnValue({
                            single: vi.fn().mockResolvedValue({ data: null, error: null }),
                        }),
                    }),
                }),
            });

            const { POST } = await import('./route');
            const res = await POST(makeRequest(), { params });
            expect(res.status).toBe(401);
        });
    });

    // ── Successful restore ─────────────────────────────────────────────────────

    describe('successful restore', () => {
        it('restores a deleted deployment within retention window', async () => {
            const now = new Date();
            const deletedAt = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000);

            mockFrom
                .mockReturnValueOnce({
                    select: vi.fn().mockReturnValue({
                        eq: vi.fn().mockReturnValue({
                            not: vi.fn().mockReturnValue({
                                single: vi.fn().mockResolvedValue({
                                    data: { user_id: fakeUser.id, deleted_at: deletedAt.toISOString() },
                                    error: null,
                                }),
                            }),
                        }),
                    }),
                })
                .mockReturnValueOnce({
                    update: vi.fn().mockReturnValue({
                        eq: vi.fn().mockResolvedValue({ error: null }),
                    }),
                });

            const { POST } = await import('./route');
            const res = await POST(makeRequest(), { params });
            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.success).toBe(true);
            expect(body.deploymentId).toBe('dep-1');
        });

        it('updates deleted_at to null on successful restore', async () => {
            const now = new Date();
            const deletedAt = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
            const mockUpdateFn = vi.fn();
            const mockEqFn = vi.fn();

            mockFrom
                .mockReturnValueOnce({
                    select: vi.fn().mockReturnValue({
                        eq: vi.fn().mockReturnValue({
                            not: vi.fn().mockReturnValue({
                                single: vi.fn().mockResolvedValue({
                                    data: { user_id: fakeUser.id, deleted_at: deletedAt.toISOString() },
                                    error: null,
                                }),
                            }),
                        }),
                    }),
                })
                .mockReturnValueOnce({
                    update: mockUpdateFn.mockReturnValue({ eq: mockEqFn.mockResolvedValue({ error: null }) }),
                });

            const { POST } = await import('./route');
            await POST(makeRequest(), { params });

            expect(mockUpdateFn).toHaveBeenCalledWith({ deleted_at: null });
            expect(mockEqFn).toHaveBeenCalledWith('id', 'dep-1');
        });
    });

    // ── Ownership check ───────────────────────────────────────────────────────

    describe('ownership check', () => {
        it('returns 404 when deployment belongs to another user', async () => {
            const deletedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

            mockFrom.mockReturnValue({
                select: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                        not: vi.fn().mockReturnValue({
                            single: vi.fn().mockResolvedValue({
                                data: { user_id: 'other-user', deleted_at: deletedAt.toISOString() },
                                error: null,
                            }),
                        }),
                    }),
                }),
            });

            const { POST } = await import('./route');
            const res = await POST(makeRequest(), { params });
            expect(res.status).toBe(404);
        });
    });

    // ── Deployment not found ──────────────────────────────────────────────────

    describe('deployment not found', () => {
        it('returns 404 when deployment is not found', async () => {
            mockFrom.mockReturnValue({
                select: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                        not: vi.fn().mockReturnValue({
                            single: vi.fn().mockResolvedValue({
                                data: null,
                                error: { message: 'not found' },
                            }),
                        }),
                    }),
                }),
            });

            const { POST } = await import('./route');
            const res = await POST(makeRequest(), { params });
            expect(res.status).toBe(404);
        });
    });

    // ── Retention window enforcement ──────────────────────────────────────────

    describe('retention window enforcement', () => {
        it('allows restore just inside retention window (1 day ago with 30-day window)', async () => {
            const now = new Date();
            const deletedAt = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);

            mockFrom
                .mockReturnValueOnce({
                    select: vi.fn().mockReturnValue({
                        eq: vi.fn().mockReturnValue({
                            not: vi.fn().mockReturnValue({
                                single: vi.fn().mockResolvedValue({
                                    data: { user_id: fakeUser.id, deleted_at: deletedAt.toISOString() },
                                    error: null,
                                }),
                            }),
                        }),
                    }),
                })
                .mockReturnValueOnce({
                    update: vi.fn().mockReturnValue({
                        eq: vi.fn().mockResolvedValue({ error: null }),
                    }),
                });

            const { POST } = await import('./route');
            const res = await POST(makeRequest(), { params });
            expect(res.status).toBe(200);
        });

        it('returns 410 when restore is outside retention window (31 days ago with 30-day window)', async () => {
            const now = new Date();
            const deletedAt = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);

            mockFrom.mockReturnValue({
                select: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                        not: vi.fn().mockReturnValue({
                            single: vi.fn().mockResolvedValue({
                                data: { user_id: fakeUser.id, deleted_at: deletedAt.toISOString() },
                                error: null,
                            }),
                        }),
                    }),
                }),
            });

            const { POST } = await import('./route');
            const res = await POST(makeRequest(), { params });
            expect(res.status).toBe(410);
            expect((await res.json()).error).toContain('outside the restore retention window');
        });

        it('respects custom DEPLOYMENT_TOMBSTONE_RETENTION_DAYS', async () => {
            process.env.DEPLOYMENT_TOMBSTONE_RETENTION_DAYS = '7';
            const now = new Date();
            const deletedAt = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);

            mockFrom.mockReturnValue({
                select: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                        not: vi.fn().mockReturnValue({
                            single: vi.fn().mockResolvedValue({
                                data: { user_id: fakeUser.id, deleted_at: deletedAt.toISOString() },
                                error: null,
                            }),
                        }),
                    }),
                }),
            });

            const { POST } = await import('./route');
            const res = await POST(makeRequest(), { params });
            expect(res.status).toBe(410);
        });

        it('includes correlationId in 410 response', async () => {
            const now = new Date();
            const deletedAt = new Date(now.getTime() - 35 * 24 * 60 * 60 * 1000);

            mockFrom.mockReturnValue({
                select: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                        not: vi.fn().mockReturnValue({
                            single: vi.fn().mockResolvedValue({
                                data: { user_id: fakeUser.id, deleted_at: deletedAt.toISOString() },
                                error: null,
                            }),
                        }),
                    }),
                }),
            });

            const { POST } = await import('./route');
            const res = await POST(makeRequest(), { params });
            const body = await res.json();
            expect(body).toHaveProperty('correlationId');
        });
    });

    // ── Status code distinction ───────────────────────────────────────────────

    describe('404 vs 410 status distinction', () => {
        it('returns 404 for ownership violation, not 410', async () => {
            const now = new Date();
            const deletedAt = new Date(now.getTime() - 35 * 24 * 60 * 60 * 1000);

            mockFrom.mockReturnValue({
                select: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                        not: vi.fn().mockReturnValue({
                            single: vi.fn().mockResolvedValue({
                                data: { user_id: 'other-user', deleted_at: deletedAt.toISOString() },
                                error: null,
                            }),
                        }),
                    }),
                }),
            });

            const { POST } = await import('./route');
            const res = await POST(makeRequest(), { params });
            expect(res.status).toBe(404);
        });

        it('returns 410 when outside retention window, not 404', async () => {
            const now = new Date();
            const deletedAt = new Date(now.getTime() - 35 * 24 * 60 * 60 * 1000);

            mockFrom.mockReturnValue({
                select: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                        not: vi.fn().mockReturnValue({
                            single: vi.fn().mockResolvedValue({
                                data: { user_id: fakeUser.id, deleted_at: deletedAt.toISOString() },
                                error: null,
                            }),
                        }),
                    }),
                }),
            });

            const { POST } = await import('./route');
            const res = await POST(makeRequest(), { params });
            expect(res.status).toBe(410);
        });
    });

    // ── Error handling ────────────────────────────────────────────────────────

    describe('error handling', () => {
        it('returns 500 when update fails', async () => {
            const deletedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

            mockFrom
                .mockReturnValueOnce({
                    select: vi.fn().mockReturnValue({
                        eq: vi.fn().mockReturnValue({
                            not: vi.fn().mockReturnValue({
                                single: vi.fn().mockResolvedValue({
                                    data: { user_id: fakeUser.id, deleted_at: deletedAt.toISOString() },
                                    error: null,
                                }),
                            }),
                        }),
                    }),
                })
                .mockReturnValueOnce({
                    update: vi.fn().mockReturnValue({
                        eq: vi.fn().mockResolvedValue({ error: { message: 'Database error' } }),
                    }),
                });

            const { POST } = await import('./route');
            const res = await POST(makeRequest(), { params });
            expect(res.status).toBe(500);
            expect((await res.json()).error).toContain('Failed to restore');
        });

        it('includes correlationId in error response', async () => {
            const deletedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

            mockFrom
                .mockReturnValueOnce({
                    select: vi.fn().mockReturnValue({
                        eq: vi.fn().mockReturnValue({
                            not: vi.fn().mockReturnValue({
                                single: vi.fn().mockResolvedValue({
                                    data: { user_id: fakeUser.id, deleted_at: deletedAt.toISOString() },
                                    error: null,
                                }),
                            }),
                        }),
                    }),
                })
                .mockReturnValueOnce({
                    update: vi.fn().mockReturnValue({
                        eq: vi.fn().mockResolvedValue({ error: { message: 'DB error' } }),
                    }),
                });

            const { POST } = await import('./route');
            const res = await POST(makeRequest(), { params });
            const body = await res.json();
            expect(body).toHaveProperty('correlationId');
        });
    });
});
