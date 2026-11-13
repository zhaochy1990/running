import { buildCoachCard, type CoachCardView } from './coachCards';
import type { MasterPlanCard } from '../services/master-plan';

/** Convert the completed job's authenticated candidate into the existing
 * confirmation card. Weekly documents remain intact in the apply payload. */
export function candidateJobReview(value: unknown): { card: CoachCardView; text: string } | null {
  if (!value || typeof value !== 'object') return null;
  const job = value as { status?: unknown; candidate_card?: unknown };
  if (job.status !== 'done') return null;
  const card = buildCoachCard(job.candidate_card, undefined);
  if (!card || card.type !== 'master-plan' || !card.buttonText) return null;
  const plan = card.data as MasterPlanCard;
  const docs = plan.content?.weekly_docs;
  if (!Array.isArray(docs)) return null;
  const lines = ['赛季训练计划候选已生成，尚未生效。请审阅首批周课后再决定是否应用。'];
  if (docs.length === 0) lines.push('', '此候选没有首批周课。');
  docs.forEach((doc, index) => {
    const week = doc && typeof doc === 'object' ? doc as Record<string, unknown> : {};
    const name = typeof week.week_name === 'string' ? week.week_name : `第 ${index + 1} 周`;
    lines.push('', `**${name}**`, '', '```json', JSON.stringify(doc, null, 2), '```');
  });
  return { card, text: lines.join('\n') };
}
