export type SeasonSummary = {
  id: string;
  status: string;
};

export function preferredSeasonId(seasons: SeasonSummary[]): string | null {
  return seasons.find((season) => season.status === 'RUNNING')?.id
    ?? seasons[0]?.id
    ?? null;
}
