import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const runtimeControl = readFileSync('src/services/runtime-control.service.ts', 'utf8');
const campaignRepository = readFileSync('src/repositories/campaign.repository.ts', 'utf8');
const complianceRepository = readFileSync('src/repositories/compliance-assessment.repository.ts', 'utf8');
const reassessment = readFileSync('src/services/compliance-reassessment.service.ts', 'utf8');
const worker = readFileSync('src/worker/index.ts', 'utf8');

describe('autonomous compliance threshold refresh', () => {
  it('invalidates all assessments when the global quality floor is changed', () => {
    expect(runtimeControl).toContain('invalidateAllComplianceAssessments');
    expect(runtimeControl).toContain('patch.minimumPublicationQuality !== undefined');
  });

  it('invalidates only affected campaign assessments when its quality floor changes', () => {
    expect(campaignRepository).toContain('invalidateComplianceAssessmentsForCampaign');
    expect(campaignRepository).toContain('patch.minimumPublicationQuality !== existing.minimumPublicationQuality');
  });

  it('makes invalidated assessments immediately appear pending', () => {
    expect(complianceRepository).toContain('listPendingComplianceCandidateIds');
    expect(complianceRepository).toContain("$match: { assessments: { $size: 0 } }");
  });

  it('rebuilds pending compliance decisions autonomously from stored evidence', () => {
    expect(reassessment).toContain('listCandidateEvidence');
    expect(reassessment).toContain('effectiveMinimumPublicationQuality');
    expect(reassessment).toContain('saveComplianceAssessment');
    expect(worker).toContain('reassessPendingCompliance(100)');
  });
});
