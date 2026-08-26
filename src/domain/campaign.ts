import { z } from 'zod';

export const campaignStatusSchema = z.enum(['draft', 'running', 'paused', 'completed', 'archived']);

export const campaignSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  categories: z.array(z.string().min(1)).min(1),
  locations: z.array(z.string().min(1)).min(1),
  dailyTarget: z.number().int().min(0),
  dailyHardLimit: z.number().int().min(1),
  minimumPublicationQuality: z.number().min(0).max(100),
  priority: z.number().int().min(1).max(100).default(50),
  status: campaignStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Campaign = z.infer<typeof campaignSchema>;

export const southWalesVenuePilot = (): Campaign => {
  const now = new Date().toISOString();
  return {
    id: 'campaign_south_wales_venues_pilot',
    name: 'South Wales Venue Pilot',
    categories: ['Venues'],
    locations: ['South Wales'],
    dailyTarget: 10,
    dailyHardLimit: 10,
    minimumPublicationQuality: 85,
    priority: 100,
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  };
};
