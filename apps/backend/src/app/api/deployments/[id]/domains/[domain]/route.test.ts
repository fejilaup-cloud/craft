import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetUser = vi.fn();
const mockFrom = vi.fn();
const mockRemoveDomainWithCleanup = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
    createClient: () => ({
        auth: { getUser: mockGetUser },
        from: mockFrom,
    }),
}));

vi.mock('@/services/vercel-domain-lifecycle.service', () => ({
    VercelDomainLifecycleService: vi.fn().mockImplementation(() => ({
        removeDomainWithCleanup: mockRemoveDomainWithCleanup,
    })),
}));

const fakeUser = { id: 'user-1' };
const params = { id: 'dep-1', domain: 'example.com' };

function makeRequest() {
    return new NextRequest(
        'http://localhost/api/deployments/dep-1/domains/example.com',
        { method: 'DELETE' },
    );
}

type QueryResult = { data: Record<string, unknown> | null; error: { message: string } | null };

function makeSupabaseQuery(results: QueryResult[], withUpdate = false) {
    const chain: Record<string, unknown> = {
        select: vi.fn(() => ({
            eq: vi.fn(() => ({
                single: vi.fn().mockResolvedValue(results.shift() ?? { data: null, error: null }),
            })),
        })),
    };
    if (withUpdate) {
        chain.update = vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) }));
    }
    return chain;
}

describe('DELETE /api/deployments/[id]/domains/[domain]', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mockGetUser.mockResolvedValue({ data: { user: fakeUser }, error: null });
    });

    it('returns 401 when unauthenticated', async () => {
        mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
        const { DELETE } = await import('./route');
        expect((await DELETE(makeRequest(), { params })).status).toBe(401);
    });

    it('returns 403 when deployment belongs to another user', async () => {
        mockFrom.mockReturnValue(
            makeSupabaseQuery([{ data: { user_id: 'other' }, error: null }]),
        );
        const { DELETE } = await import('./route');
        expect((await DELETE(makeRequest(), { params })).status).toBe(403);
    });

    it('returns 404 when deployment is not found', async () => {
        mockFrom
            .mockReturnValueOnce(makeSupabaseQuery([{ data: { user_id: fakeUser.id }, error: null }]))
            .mockReturnValueOnce(makeSupabaseQuery([{ data: null, error: { message: 'not found' } }]));
        const { DELETE } = await import('./route');
        expect((await DELETE(makeRequest(), { params })).status).toBe(404);
    });

    it('returns 404 when no Vercel project is configured', async () => {
        mockFrom
            .mockReturnValueOnce(makeSupabaseQuery([{ data: { user_id: fakeUser.id }, error: null }]))
            .mockReturnValueOnce(makeSupabaseQuery([{ data: { vercel_project_id: null, custom_domain: null }, error: null }]));
        const { DELETE } = await import('./route');
        const res = await DELETE(makeRequest(), { params });
        expect(res.status).toBe(404);
        expect((await res.json()).error).toMatch(/no vercel project/i);
    });

    it('returns 200 with aliasesMatched and clears custom_domain when it matches', async () => {
        const mockUpdate = vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) }));
        mockFrom
            .mockReturnValueOnce(makeSupabaseQuery([{ data: { user_id: fakeUser.id }, error: null }]))
            .mockReturnValueOnce({
                select: vi.fn(() => ({
                    eq: vi.fn(() => ({
                        single: vi.fn().mockResolvedValue({
                            data: { vercel_project_id: 'prj_1', custom_domain: 'example.com' },
                            error: null,
                        }),
                    })),
                })),
            })
            .mockReturnValueOnce({ update: mockUpdate });
        mockRemoveDomainWithCleanup.mockResolvedValue({
            success: true,
            domain: 'example.com',
            aliasesMatched: 2,
        });

        const { DELETE } = await import('./route');
        const res = await DELETE(makeRequest(), { params });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.deleted).toBe(true);
        expect(body.domain).toBe('example.com');
        expect(body.aliasesMatched).toBe(2);
        expect(mockUpdate).toHaveBeenCalledWith({ custom_domain: null });
    });

    it('returns 200 with aliasesMatched: 0 and does not clear custom_domain when it differs', async () => {
        mockFrom
            .mockReturnValueOnce(makeSupabaseQuery([{ data: { user_id: fakeUser.id }, error: null }]))
            .mockReturnValueOnce({
                select: vi.fn(() => ({
                    eq: vi.fn(() => ({
                        single: vi.fn().mockResolvedValue({
                            data: { vercel_project_id: 'prj_1', custom_domain: 'other.com' },
                            error: null,
                        }),
                    })),
                })),
            });
        mockRemoveDomainWithCleanup.mockResolvedValue({
            success: true,
            domain: 'example.com',
            aliasesMatched: 0,
        });

        const { DELETE } = await import('./route');
        const res = await DELETE(makeRequest(), { params });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.aliasesMatched).toBe(0);
    });

    it('returns 200 with partialFailure fields when alias cleanup partially fails', async () => {
        mockFrom
            .mockReturnValueOnce(makeSupabaseQuery([{ data: { user_id: fakeUser.id }, error: null }]))
            .mockReturnValueOnce({
                select: vi.fn(() => ({
                    eq: vi.fn(() => ({
                        single: vi.fn().mockResolvedValue({
                            data: { vercel_project_id: 'prj_1', custom_domain: null },
                            error: null,
                        }),
                    })),
                })),
            });
        mockRemoveDomainWithCleanup.mockResolvedValue({
            success: true,
            domain: 'example.com',
            aliasesMatched: 1,
            partialFailure: true,
            partialFailureReason: 'Alias cleanup encountered errors: deployment dep-2: 503',
        });

        const { DELETE } = await import('./route');
        const res = await DELETE(makeRequest(), { params });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.aliasesMatched).toBe(1);
        expect(body.partialFailure).toBe(true);
        expect(body.partialFailureReason).toMatch(/alias cleanup/i);
    });

    it('returns 500 when removeDomainWithCleanup reports failure', async () => {
        mockFrom
            .mockReturnValueOnce(makeSupabaseQuery([{ data: { user_id: fakeUser.id }, error: null }]))
            .mockReturnValueOnce({
                select: vi.fn(() => ({
                    eq: vi.fn(() => ({
                        single: vi.fn().mockResolvedValue({
                            data: { vercel_project_id: 'prj_1', custom_domain: null },
                            error: null,
                        }),
                    })),
                })),
            });
        mockRemoveDomainWithCleanup.mockResolvedValue({
            success: false,
            domain: 'example.com',
            aliasesMatched: 0,
            partialFailureReason: 'Failed to remove domain from Vercel',
        });

        const { DELETE } = await import('./route');
        expect((await DELETE(makeRequest(), { params })).status).toBe(500);
    });

    // ── HTTPS status reset on domain detach (Issue #1252) ───────────────────────

    describe('HTTPS status reset on domain detach (#1252)', () => {
        it('clears custom_domain to reset HTTPS status when domain is detached', async () => {
            const mockUpdate = vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) }));
            mockFrom
                .mockReturnValueOnce(makeSupabaseQuery([{ data: { user_id: fakeUser.id }, error: null }]))
                .mockReturnValueOnce({
                    select: vi.fn(() => ({
                        eq: vi.fn(() => ({
                            single: vi.fn().mockResolvedValue({
                                data: { vercel_project_id: 'prj_1', custom_domain: 'example.com' },
                                error: null,
                            }),
                        })),
                    })),
                })
                .mockReturnValueOnce({ update: mockUpdate });
            mockRemoveDomainWithCleanup.mockResolvedValue({
                success: true,
                domain: 'example.com',
                aliasesMatched: 1,
            });

            const { DELETE } = await import('./route');
            await DELETE(makeRequest(), { params });

            // Verify that custom_domain is cleared, which resets the HTTPS status
            expect(mockUpdate).toHaveBeenCalledWith({ custom_domain: null });
        });

        it('prevents stale HTTPS status after domain removal and re-addition', async () => {
            // This test verifies the fix for #1252:
            // Before: domain delete didn't clear custom_domain, so HTTPS endpoint
            //         would still return stale cert status from before deletion
            // After: domain delete clears custom_domain, so HTTPS endpoint
            //        will return 404, forcing fresh provisioning on re-addition
            const mockUpdate = vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) }));
            mockFrom
                .mockReturnValueOnce(makeSupabaseQuery([{ data: { user_id: fakeUser.id }, error: null }]))
                .mockReturnValueOnce({
                    select: vi.fn(() => ({
                        eq: vi.fn(() => ({
                            single: vi.fn().mockResolvedValue({
                                data: { vercel_project_id: 'prj_1', custom_domain: 'example.com' },
                                error: null,
                            }),
                        })),
                    })),
                })
                .mockReturnValueOnce({ update: mockUpdate });
            mockRemoveDomainWithCleanup.mockResolvedValue({
                success: true,
                domain: 'example.com',
                aliasesMatched: 0,
            });

            const { DELETE } = await import('./route');
            const res = await DELETE(makeRequest(), { params });

            expect(res.status).toBe(200);
            // After domain detach, custom_domain field is set to null,
            // which forces the HTTPS status endpoint to return 404.
            // On re-addition, the domain will start fresh from 'pending' state.
            expect(mockUpdate).toHaveBeenCalledWith({ custom_domain: null });
        });
    });
});
