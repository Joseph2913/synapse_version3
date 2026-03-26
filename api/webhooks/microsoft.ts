import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 10;

// ─── ENVIRONMENT ───────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const MICROSOFT_WEBHOOK_SECRET = process.env.MICROSOFT_WEBHOOK_SECRET || 'synapse-ms-webhook';

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface GraphNotification {
  subscriptionId: string;
  changeType: 'created' | 'updated' | 'deleted';
  resource: string;
  resourceData?: {
    id: string;
    '@odata.type': string;
    '@odata.id': string;
  };
  clientState?: string;
  tenantId?: string;
  subscriptionExpirationDateTime?: string;
}

interface NotificationPayload {
  value: GraphNotification[];
}

// ─── HANDLER ──────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Microsoft Graph sends a validation request when creating subscriptions
  if (req.method === 'GET' || req.query.validationToken) {
    const validationToken = req.query.validationToken;
    if (validationToken) {
      // Echo back the validation token with text/plain content type
      res.setHeader('Content-Type', 'text/plain');
      return res.status(200).send(validationToken);
    }
    return res.status(200).send('OK');
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const payload = req.body as NotificationPayload;

    if (!payload?.value || !Array.isArray(payload.value)) {
      return res.status(200).json({ status: 'no_notifications' });
    }

    const supabase = getSupabase();
    let queued = 0;

    for (const notification of payload.value) {
      // Validate client state to prevent spoofed notifications
      if (notification.clientState && notification.clientState !== MICROSOFT_WEBHOOK_SECRET) {
        console.warn('[microsoft-webhook] Invalid clientState, skipping notification');
        continue;
      }

      // Only process created/updated events
      if (notification.changeType === 'deleted') continue;

      // Find the integration by subscription ID
      const { data: integration } = await supabase
        .from('microsoft_integrations')
        .select('user_id')
        .or(`calendar_subscription_id.eq.${notification.subscriptionId},mail_subscription_id.eq.${notification.subscriptionId}`)
        .maybeSingle();

      if (!integration) {
        console.warn('[microsoft-webhook] No integration found for subscription:', notification.subscriptionId);
        continue;
      }

      // Determine resource type from the notification resource path
      const resourcePath = notification.resource;
      let resourceType: 'calendar_event' | 'email' = 'calendar_event';
      if (resourcePath.includes('/messages')) {
        resourceType = 'email';
      }

      // Extract the resource ID
      const resourceId = notification.resourceData?.id || resourcePath.split('/').pop() || '';
      if (!resourceId) continue;

      // Queue for processing (upsert to avoid duplicates)
      const { error: queueError } = await supabase
        .from('microsoft_ingestion_queue')
        .upsert({
          user_id: integration.user_id,
          microsoft_resource_id: resourceId,
          resource_type: resourceType,
          status: 'pending',
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id,microsoft_resource_id', ignoreDuplicates: true });

      if (queueError) {
        console.warn('[microsoft-webhook] Queue upsert error:', queueError.message);
      } else {
        queued++;
      }
    }

    // Microsoft requires a 200 response within 3 seconds
    return res.status(200).json({ queued });
  } catch (err) {
    console.error('[microsoft-webhook] Error:', err);
    // Still return 200 to prevent Microsoft from retrying
    return res.status(200).json({ error: 'processing_failed' });
  }
}
