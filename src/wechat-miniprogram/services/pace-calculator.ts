import { http } from './request';

export interface PaceRaceTemplate {
  key: string;
  name: string;
  distance_km: number;
  difficulty: string;
  terrain: string;
  description: string;
  segments: {
    start_km: number;
    end_km: number;
    pace_delta_seconds: number;
    terrain: string;
    note: string;
  }[];
}

export async function fetchPaceRaceTemplates(): Promise<PaceRaceTemplate[]> {
  const { templates } = await http.get<{ templates: PaceRaceTemplate[] }>(
    '/api/pace-calculator/race-templates',
    { auth: false },
  );
  return templates;
}
