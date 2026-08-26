import type { Collection } from 'mongodb';
import {
  complianceAssessmentSchema,
  type ComplianceAssessment,
} from '../domain/compliance-assessment.js';
import { getDatabase } from '../lib/mongo.js';

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
