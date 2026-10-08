'use server';

import { revalidatePath } from 'next/cache';
import { setOpsStatus } from '@/lib/twin';
import type { OpsStatus } from '@/lib/types';

export async function markCall(formData: FormData): Promise<void> {
  const runId = String(formData.get('run_id') ?? '');
  const status = String(formData.get('status') ?? '') as Exclude<OpsStatus, null>;
  if (!runId || !['confirmed', 'followed_up'].includes(status)) return;
  await setOpsStatus(runId, status);
  revalidatePath('/');
}
