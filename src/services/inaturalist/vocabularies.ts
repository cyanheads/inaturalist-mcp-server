/**
 * @fileoverview Spec-derived controlled vocabularies the iNaturalist API accepts
 * as filter values but publishes no endpoint for. Served as the static half of
 * `inaturalist_list_reference`, and reused as the Zod enums every filtered tool
 * validates against.
 * @module services/inaturalist/vocabularies
 */

/** One row of a static vocabulary table. */
export type VocabularyEntry = {
  code: string;
  label: string;
  notes?: string;
};

export const QUALITY_GRADES = ['research', 'needs_id', 'casual'] as const;

export type QualityGrade = (typeof QUALITY_GRADES)[number];

/**
 * Narrows an upstream grade string to the documented vocabulary. A value outside
 * it means iNaturalist changed the vocabulary; reporting the least-confident
 * tier keeps the rest of the page usable, where failing the output parse would
 * discard every record over one unexpected field.
 */
export function toQualityGrade(raw: string | null | undefined): QualityGrade {
  for (const grade of QUALITY_GRADES) {
    if (grade === raw) return grade;
  }
  return 'casual';
}

export const ICONIC_TAXA = [
  'Actinopterygii',
  'Amphibia',
  'Animalia',
  'Arachnida',
  'Aves',
  'Chromista',
  'Fungi',
  'Insecta',
  'Mammalia',
  'Mollusca',
  'Plantae',
  'Protozoa',
  'Reptilia',
  'unknown',
] as const;

export const RANKS = [
  'stateofmatter',
  'kingdom',
  'phylum',
  'subphylum',
  'superclass',
  'class',
  'subclass',
  'superorder',
  'order',
  'suborder',
  'infraorder',
  'superfamily',
  'epifamily',
  'family',
  'subfamily',
  'supertribe',
  'tribe',
  'subtribe',
  'genus',
  'genushybrid',
  'species',
  'hybrid',
  'subspecies',
  'variety',
  'form',
] as const;

export const CONSERVATION_STATUS_CODES = ['LC', 'NT', 'VU', 'EN', 'CR', 'EW', 'EX'] as const;

export const LICENSE_CODES = [
  'cc-by',
  'cc-by-nc',
  'cc-by-nd',
  'cc-by-sa',
  'cc-by-nc-nd',
  'cc-by-nc-sa',
  'cc0',
] as const;

/** Rank levels the spec publishes; the remaining ranks sit between these rungs. */
const RANK_LEVELS: Readonly<Record<string, number>> = {
  kingdom: 70,
  phylum: 60,
  class: 50,
  order: 40,
  family: 30,
  genus: 20,
  species: 10,
  subspecies: 5,
};

const QUALITY_GRADE_ENTRIES: readonly VocabularyEntry[] = [
  {
    code: 'research',
    label: 'Research grade',
    notes:
      'Community-confirmed identification with a date, a location, and supporting media. The default this server searches.',
  },
  {
    code: 'needs_id',
    label: 'Needs identification',
    notes:
      'Verifiable but not yet community-confirmed. Roughly doubles the corpus and lowers identification confidence.',
  },
  {
    code: 'casual',
    label: 'Casual',
    notes: 'Captive or cultivated, missing a date or location, or otherwise unverifiable.',
  },
  {
    code: 'accurate',
    label: 'Location is accurate',
    notes: 'Data-quality criterion behind the grade, not a quality_grade value.',
  },
  {
    code: 'date',
    label: 'Date is specified',
    notes: 'Data-quality criterion behind the grade, not a quality_grade value.',
  },
  {
    code: 'evidence',
    label: 'Evidence of an organism is attached',
    notes: 'Data-quality criterion behind the grade, not a quality_grade value.',
  },
  {
    code: 'location',
    label: 'Location is specified',
    notes: 'Data-quality criterion behind the grade, not a quality_grade value.',
  },
  {
    code: 'needs_id',
    label: 'Community still wants an identification',
    notes:
      'Data-quality criterion behind the grade. Shares a name with the grade above but is the separate criterion filter.',
  },
  {
    code: 'recent',
    label: 'Evidence is recent',
    notes: 'Data-quality criterion behind the grade, not a quality_grade value.',
  },
  {
    code: 'subject',
    label: 'Evidence is of a single subject',
    notes: 'Data-quality criterion behind the grade, not a quality_grade value.',
  },
  {
    code: 'wild',
    label: 'Organism is wild',
    notes:
      'Data-quality criterion behind the grade. The captive parameter on the search tools is the filter that reads it.',
  },
];

const LICENSE_ENTRIES: readonly VocabularyEntry[] = [
  { code: 'cc0', label: 'CC0 public domain dedication' },
  { code: 'cc-by', label: 'Creative Commons Attribution' },
  { code: 'cc-by-nc', label: 'Creative Commons Attribution-NonCommercial' },
  { code: 'cc-by-nd', label: 'Creative Commons Attribution-NoDerivatives' },
  { code: 'cc-by-sa', label: 'Creative Commons Attribution-ShareAlike' },
  { code: 'cc-by-nc-nd', label: 'Creative Commons Attribution-NonCommercial-NoDerivatives' },
  { code: 'cc-by-nc-sa', label: 'Creative Commons Attribution-NonCommercial-ShareAlike' },
  {
    code: 'null',
    label: 'All rights reserved',
    notes:
      'A record whose license_code is JSON null. There is no code to pass as a filter value — use the licensed or photo_licensed booleans to exclude these.',
  },
];

const ICONIC_TAXON_LABELS: Readonly<Record<(typeof ICONIC_TAXA)[number], string>> = {
  Actinopterygii: 'Ray-finned fishes',
  Amphibia: 'Amphibians',
  Animalia: 'Animals not covered by another iconic group',
  Arachnida: 'Arachnids',
  Aves: 'Birds',
  Chromista: 'Chromists',
  Fungi: 'Fungi, including lichens',
  Insecta: 'Insects',
  Mammalia: 'Mammals',
  Mollusca: 'Molluscs',
  Plantae: 'Plants',
  Protozoa: 'Protozoans',
  Reptilia: 'Reptiles',
  unknown: 'No iconic group assigned',
};

const CONSERVATION_STATUS_LABELS: Readonly<
  Record<(typeof CONSERVATION_STATUS_CODES)[number], string>
> = {
  LC: 'Least concern',
  NT: 'Near threatened',
  VU: 'Vulnerable',
  EN: 'Endangered',
  CR: 'Critically endangered',
  EW: 'Extinct in the wild',
  EX: 'Extinct',
};

/** The static topics, keyed by the `topic` value that selects them. */
export const STATIC_VOCABULARIES: Readonly<Record<string, readonly VocabularyEntry[]>> = {
  quality_grades: QUALITY_GRADE_ENTRIES,
  licenses: LICENSE_ENTRIES,
  ranks: RANKS.map((rank) => {
    const level = RANK_LEVELS[rank];
    return {
      code: rank,
      label: rank,
      ...(level === undefined ? {} : { notes: `rank_level ${level}.` }),
    };
  }),
  iconic_taxa: ICONIC_TAXA.map((code) => ({ code, label: ICONIC_TAXON_LABELS[code] })),
  conservation_status_codes: CONSERVATION_STATUS_CODES.map((code) => ({
    code,
    label: CONSERVATION_STATUS_LABELS[code],
  })),
};
