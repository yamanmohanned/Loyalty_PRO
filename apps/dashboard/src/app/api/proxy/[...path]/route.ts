import { NextResponse } from 'next/server';
import { apiFetch } from '@/lib/server-api';

/**
 * Authenticated proxy to the loyalty API.
 *
 * Client components fetch through here rather than calling the API directly, so
 * the access token can live in an httpOnly cookie that JavaScript cannot read.
 * `apiFetch` attaches it server-side and refreshes transparently on expiry.
 *
 * Only the methods the dashboard actually uses are exported — an unexported verb
 * is a 405, which keeps the proxy from becoming a general-purpose tunnel.
 */

type Params = { params: Promise<{ path: string[] }> };

async function forward(request: Request, { params }: Params): Promise<NextResponse> {
  const { path } = await params;
  const search = new URL(request.url).search;
  const target = `/${path.join('/')}${search}`;

  const body =
    request.method === 'GET' || request.method === 'DELETE'
      ? undefined
      : await request.text();

  const result = await apiFetch(target, {
    method: request.method,
    ...(body ? { body } : {}),
  });

  if (result.error) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(result.data ?? {}, { status: result.status });
}

export const GET = forward;
export const POST = forward;
export const PATCH = forward;
export const PUT = forward;
export const DELETE = forward;
