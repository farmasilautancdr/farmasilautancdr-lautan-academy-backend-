// Area Manager regions. Never had a backend home before — GAS only ever
// kept this as a client-side dropdown (index.html), unvalidated server-side.
// Canonical here now since area_manager scoping depends on it.
export const AREAS = [
  { id: 'R1 - AMIRUL', outlets: ['DG', 'DGD', 'KMD', 'KMN', 'KMSK', 'MR'] },
  { id: 'R2 - HAZWANI', outlets: ['AJ', 'BJR', 'BP', 'HQCT', 'KB', 'WM', 'PDM'] },
  { id: 'R3 - HARIS', outlets: ['B6', 'BB', 'CDR', 'HL', 'HQ', 'KL', 'PK'] },
  { id: 'R4 - RAIHAN', outlets: ['GB', 'GBD', 'JTH', 'RJ', 'ST', 'TPOH'] },
  { id: 'R5 - ADNIN', outlets: ['JL', 'JLD', 'PP', 'PSPD', 'SMR'] },
  { id: 'R6 - NADHIRAH', outlets: ['KS', 'MC', 'MLR', 'TM', 'TMD', 'TMT', 'MCD'] },
  { id: 'R7 - HASANUL', outlets: ['KBKK', 'KBKS', 'KBTJ', 'PC', 'PT'] },
  { id: 'R8 - HAFSHAM', outlets: ['PM', 'SLS', 'TPT', 'KKR', 'PPK'] },
  { id: 'R9 - IFFAH / RAIHAN', outlets: ['GM', 'CK'] },
];

export function outletsForArea(areaId) {
  return AREAS.find((a) => a.id === areaId)?.outlets || null;
}
