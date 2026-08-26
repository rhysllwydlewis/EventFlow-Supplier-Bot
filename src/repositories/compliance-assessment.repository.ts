import type { Collection } from 'mongodb';
import {
  complianceAssessmentSchema,
  type ComplianceAssessment,
} from '../domain/compliance-assessment.js';
import { getDatabase } from '../lib/mongo.js';

export type ComplianceOverview = {
  total: number;
  publicationEligible: number;
  review: number;
  blocked: number;
  seoReady: number;
};

async function collection(): Promise<Collection<ComplianceAssessment>> {
  const db = await getDatabase();
  return db.collection<ComplianceAssessment>('compliance_assessments');
}

export async function saveComplianceAssessment(
  assessment: ComplianceAssessment,
): Promise<ComplianceAssessment> {
  const validated = complianceAssessmentSchema.parse(assessment);
  const store = await collection();
  await store.replaceOne({ candidateId: validated.candidateId }, validated, { upsert: true });
  return validated;
}

export async function listComplianceAssessments(limit = 100): Promise<ComplianceAssessment[]> {
  const store = await collection();
  const records = await store
    .find({})
    .sort({ assessedAt: -1 })
    .limit(Math.min(Math.max(limit, 1), 500))
    .toArray();
  return records.map(record => complianceAssessmentSchema.parse(record));
}

export async function getComplianceAssessmentsForCandidates(
  candidateIds: string[],
): Promise<ComplianceAssessment[]> {
  const uniqueIds = [...new Set(candidateIds.filter(Boolean))];
  if (uniqueIds.length === 0) return [];
  const store = await collection();
  const records = await store.find({ candidateId: { $in: uniqueIds } }).toArray();
  return records.map(record => complianceAssessmentSchema.parse(record));
}

export async function getComplianceOverview(): Promise<ComplianceOverview> {
  const store = await collection();
  const rows = await store.aggregate<{
    _id: null;
    total: number;
    publicationEligible: number;
    review: number;
    blocked: number;
    seoReady: number;
  }>([
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        publicationEligible: { $sum: { $cond: ['$publicationEligible', 1, 0] } },
        review: { $sum: { $cond: [{ $eq: ['$status', 'review'] }, 1, 0] } },
        blocked: { $sum: { $cond: [{ $eq: ['$status', 'block'] }, 1, 0] } },
        seoReady: { $sum: { $cond: ['$seoIndexEligible', 1, 0] } },
      },
    },
  ]).toArray();
  const row = rows[0];
  if (!row) {
    return { total: 0, publicationEligible: 0, review: 0, blocked: 0, seoReady: 0 };
  }
  return {
    total: row.total,
    publicationEligible: row.publicationEligible,
    review: row.review,
    blocked: row.blocked,
    seoReady: row.seoReady,
  };
}
