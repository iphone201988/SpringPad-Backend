import type { PrismaService } from '../prisma.service.js';

/**
 * Brief §4 hook: any AI generation service plugs in here (first planned: the growth montage, on self-hosted
 * interpolation models such as FILM or RIFE), so nothing else depends on a vendor or model.
 * Inputs and outputs are keys in the private master store, so large files never pass through the API and
 * children's photos only go where the provider runs.
 */
export interface GenerationProvider {
  readonly name: string;
  generate(job: { id: string; kind: string; inputKeys: string[] }): Promise<{ resultKey: string; previewKey?: string }>;
}

/**
 * Runs one queued job on its provider and records the result. Calling it twice is harmless: only a QUEUED job
 * is claimed. Input photos are re-checked against parent_child_link, so a revoked link fails the job.
 */
export async function runJob(db: PrismaService, providers: GenerationProvider[], jobId: string) {
  const [job] = await db.generationJob.updateManyAndReturn({ where: { id: jobId, status: 'QUEUED' }, data: { status: 'RUNNING' } });
  if (!job) return;
  try {
    const provider = providers.find((p) => p.name === job.provider);
    if (!provider) throw new Error(`No provider called "${job.provider}"`);
    const inputs = await db.imageAsset.findMany({
      where: { id: { in: job.inputImageIds }, isAnchor: false, child: { links: { some: { customerId: job.customerId, status: 'ACTIVE' } } } },
      select: { id: true, masterKey: true },
    });
    const keys = job.inputImageIds.map((id) => inputs.find((i) => i.id === id)?.masterKey);
    if (!keys.length || keys.some((k) => !k)) throw new Error('A photo is missing or the parent no longer has access to it');
    const out = await provider.generate({ id: job.id, kind: job.kind, inputKeys: keys as string[] });
    await db.generationJob.update({ where: { id: job.id }, data: { status: 'DONE', resultKey: out.resultKey, previewKey: out.previewKey ?? null, error: null } });
  } catch (e) {
    await db.generationJob.update({ where: { id: job.id }, data: { status: 'FAILED', error: String((e as Error).message ?? e).slice(0, 500) } });
  }
}
