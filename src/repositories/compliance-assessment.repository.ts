import type { Collection } from 'mongodb';
import {
  complianceAssessmentSchema,
  type ComplianceAssessment,
} from '../domain/compliance-assessment.js';
import { getDatabase } from '../lib/mongo.js';

export type ComplianceOverview = {
  totalProfiles: number;
  assessed: number;
  pending: number;
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
  const db = await getDatabase();
  const rows = await db.collection('shadow_profiles').aggregate<{
    _id: null;
    totalProfiles: number;
    assessed: number;
    pending: number;
    publicationEligible: number;
    review: number;
    blocked: number;
    seoReady: number;
  }>([
    {
      $lookup: {
        from: 'compliance_assessments',
        localField: 'candidateId',
        foreignField: 'candidateId',
        as: 'assessments',
      },
    },
    {
      $set: {
        assessment: { $arrayElemAt: ['$assessments', 0] },
        hasAssessment: { $gt: [{ $size: '$assessments' }, 0] },
      },
    },
    {
      $group: {
        _id: null,
        totalProfiles: { $sum: 1 },
        assessed: { $sum: { $cond: ['$hasAssessment', 1, 0] } },
        pending: { $sum: { $cond: ['$hasAssessment', 0, 1] } },
        publicationEligible: { $sum: { $cond: ['$assessment.publicationEligible', 1, 0] } },
        review: { $sum: { $cond: [{ $eq: ['$assessment.status', 'review'] }, 1, 0] } },
        blocked: { $sum: { $cond: [{ $eq: ['$assessment.status', 'block'] }, 1, 0] } },
        seoReady: { $sum: { $cond: ['$assessment.seoIndexEligible', 1, 0] } },
      },
    },
  ]).toArray();
  const row = rows[0];
  if (!row) {
    return {
      totalProfiles: 0,
      assessed: 0,
      pending: 0,
      publicationEligible: 0,
      review: 0,
      blocked: 0,
      seoReady: 0,
    };
  }
  return {
    totalProfiles: row.totalProfiles,
    assessed: row.assessed,
    pending: row.pending,
    publicationEligible: row.publicationEligible,
    review: row.review,
    blocked: row.blocked,
    seoReady: row.seoReady,
  };
}
