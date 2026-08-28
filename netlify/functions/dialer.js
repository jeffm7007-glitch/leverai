const axios = require('axios');

// Pipedrive config
const PIPEDRIVE_API_KEY = process.env.PIPEDRIVE_API_KEY || '0389a84ea32985f8990f057abc839a167a435790';
const PIPEDRIVE_DOMAIN = process.env.PIPEDRIVE_DOMAIN || 'proplumnetwork';
const pipedriveBase = `https://${PIPEDRIVE_DOMAIN}.pipedrive.com/v1`;

// In-memory state (resets on cold start, but Pipedrive is the source of truth)
const leadQueue = [];
const callLog = [];

const DISPOSITION_STAGES = {
  'interested': { stage: 7, pipeline: 2, followUp: false },
  'callback': { stage: 6, pipeline: 2, followUp: true },
  'left_voicemail': { stage: 6, pipeline: 2, followUp: true },
  'missed': { stage: 6, pipeline: 2, followUp: true },
  'not_in': { stage: 6, pipeline: 2, followUp: true },
  'wrong_number': { stage: null, pipeline: 2, followUp: false }
};

async function pipedriveRequest(method, endpoint, data = null) {
  let url = `${pipedriveBase}${endpoint}?api_token=${PIPEDRIVE_API_KEY}`;
  if (method.toLowerCase() === 'get' && data) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(data)) params.append(key, value);
    url += '&' + params.toString();
  }
  try {
    const config = { method, url };
    if (method.toLowerCase() !== 'get' && data) config.data = data;
    const response = await axios(config);
    return response.data;
  } catch (error) {
    console.error('Pipedrive API error:', error.response?.data || error.message);
    throw error;
  }
}

async function findOrCreatePerson(name, phone) {
  try {
    const search = await pipedriveRequest('get', `/persons/search`, { term: phone, fields: 'phone' });
    if (search?.data?.items?.length > 0) return search.data.items[0].item.id;
  } catch (e) {}
  const person = await pipedriveRequest('post', '/persons', {
    name: name,
    phone: [{ value: phone, primary: true, label: 'work' }]
  });
  return person?.data?.id;
}

async function createDeal(title, personId) {
  const deal = await pipedriveRequest('post', '/deals', {
    title, person_id: personId, value: 0, currency: 'USD', pipeline_id: 2
  });
  return deal?.data?.id;
}

async function logCallActivity(dealId, personId, note, duration = 0) {
  await pipedriveRequest('post', '/activities', {
    subject: 'Call - ProPlum Outreach',
    deal_id: dealId, person_id: personId, type: 'call',
    note, duration, done: 1
  });
}

async function updateDealByDisposition(dealId, disposition) {
  const mapping = DISPOSITION_STAGES[disposition];
  if (!mapping || !mapping.stage) return;
  await pipedriveRequest('put', `/deals/${dealId}`, { 
    stage_id: mapping.stage, pipeline_id: mapping.pipeline 
  });
  if (mapping.followUp) {
    await pipedriveRequest('post', '/activities', {
      subject: 'Follow-up required',
      deal_id: dealId, type: 'call',
      note: `Auto-created: Disposition was "${disposition}".`,
      due_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      done: 0
    });
  }
}

// CORS headers
const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async (event, context) => {
  const path = event.path.replace('/.netlify/functions/dialer', '').replace('/api', '');
  const method = event.httpMethod;

  if (method === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    // GET /leads/next
    if (path === '/leads/next' && method === 'GET') {
      const nextLead = leadQueue.find(l => !l.called);
      if (!nextLead) {
        return { statusCode: 200, headers, body: JSON.stringify({ done: true, message: 'All leads called!' }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify(nextLead) };
    }

    // POST /leads/:id/disposition
    if (path.match(/^\/leads\/\d+\/disposition$/) && method === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { disposition, notes, duration, lead } = body;
      
      if (!DISPOSITION_STAGES[disposition]) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid disposition', valid: Object.keys(DISPOSITION_STAGES) }) };
      }

      const leadData = lead || {};
      const personId = await findOrCreatePerson(leadData.name || 'Unknown', leadData.phone || '');
      const dealTitle = `${leadData.name || 'Lead'} - ${leadData.city || ''}`.trim();
      const dealId = await createDeal(dealTitle, personId);
      
      const note = `Disposition: ${disposition}\nDuration: ${duration}s\nNotes: ${notes || 'N/A'}\nCity: ${leadData.city || 'N/A'}`;
      await logCallActivity(dealId, personId, note, duration || 0);
      await updateDealByDisposition(dealId, disposition);

      return { statusCode: 200, headers, body: JSON.stringify({ success: true, deal_id: dealId, person_id: personId }) };
    }

    // POST /leads/upload
    if (path === '/leads/upload' && method === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { leads } = body;
      leadQueue.push(...leads.map((l, idx) => ({ ...l, id: leadQueue.length + idx + 1, called: false })));
      return { statusCode: 200, headers, body: JSON.stringify({ uploaded: leads.length, total: leadQueue.length }) };
    }

    // GET /stats
    if (path === '/stats' && method === 'GET') {
      const total = leadQueue.length;
      const called = leadQueue.filter(l => l.called).length;
      const interested = leadQueue.filter(l => l.disposition === 'interested').length;
      return { statusCode: 200, headers, body: JSON.stringify({
        total, called, remaining: total - called, interested,
        conversionRate: called > 0 ? ((interested / called) * 100).toFixed(1) : 0
      })};
    }

    // GET /health
    if (path === '/health' && method === 'GET') {
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }) };
    }

    // 404
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Not found', path, method }) };

  } catch (error) {
    console.error('Error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
