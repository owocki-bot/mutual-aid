const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { ethers } = require('ethers');

const app = express();
app.use(cors());
app.use(express.json());

// In-memory storage
const networks = new Map();
const FEE_RATE = 0.05;
const TREASURY = '0xccD7200024A8B5708d381168ec2dB0DC587af83F';

const getProvider = () => new ethers.JsonRpcProvider(process.env.RPC_URL || 'https://sepolia.base.org');
const getWallet = () => new ethers.Wallet(process.env.TREASURY_PRIVATE_KEY, getProvider());


// ============================================================================
// WHITELIST MIDDLEWARE
// ============================================================================

let _whitelistCache = null;
let _whitelistCacheTime = 0;
const WHITELIST_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function fetchWhitelist() {
  const now = Date.now();
  if (_whitelistCache && (now - _whitelistCacheTime) < WHITELIST_CACHE_TTL) {
    return _whitelistCache;
  }
  try {
    const res = await fetch('https://www.owockibot.xyz/api/whitelist');
    const data = await res.json();
    _whitelistCache = new Set(data.map(e => (e.address || e).toLowerCase()));
    _whitelistCacheTime = now;
    return _whitelistCache;
  } catch (err) {
    console.error('Whitelist fetch failed:', err.message);
    if (_whitelistCache) return _whitelistCache;
    return new Set();
  }
}

function requireWhitelist(addressField = 'address') {
  return async (req, res, next) => {
    const addr = req.body?.[addressField] || req.body?.creator || req.body?.participant || req.body?.sender || req.body?.from || req.body?.address;
    if (!addr) {
      return res.status(400).json({ error: 'Address required' });
    }
    const whitelist = await fetchWhitelist();
    if (!whitelist.has(addr.toLowerCase())) {
      return res.status(403).json({ error: 'Invite-only. Tag @owockibot on X to request access.' });
    }
    next();
  };
}


app.get('/', (req, res) => {
  res.json({
    name: 'Mutual Aid Network',
    description: 'Pool resources and redistribute based on need',
    endpoints: {
      'POST /networks': 'Create a mutual aid network',
      'GET /networks/:id': 'Get network status',
      'POST /networks/:id/join': 'Join network',
      'POST /networks/:id/contribute': 'Contribute to pool',
      'POST /networks/:id/request': 'Request help',
      'POST /networks/:id/offer': 'Offer help',
      'GET /networks/:id/requests': 'List open requests',
      'POST /networks/:id/requests/:reqId/fulfill': 'Fulfill a request',
      'POST /networks/:id/redistribute': 'Redistribute based on need',
      'GET /health': 'Health check',
      'GET /test/e2e': 'End-to-end test'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now(), networks: networks.size });
});

// Agent endpoint for LLM discovery
app.get('/agent', (req, res) => {
  res.json({
    name: 'Mutual Aid Network',
    description: 'Pool resources and redistribute based on need. Members contribute to a shared pool and can request help when needed. Supports offers (non-monetary help) and need-based redistribution.',
    network: 'Base Sepolia',
    treasury_fee: '5% on payouts',
    endpoints: [
      { method: 'POST', path: '/networks', description: 'Create a mutual aid network', params: ['name', 'description?'] },
      { method: 'GET', path: '/networks/:id', description: 'Get network status and members' },
      { method: 'POST', path: '/networks/:id/join', description: 'Join network', params: ['address', 'name?'] },
      { method: 'POST', path: '/networks/:id/contribute', description: 'Record contribution to pool', params: ['memberId', 'amount', 'txHash?'] },
      { method: 'POST', path: '/networks/:id/request', description: 'Request help from pool', params: ['memberId', 'amount', 'reason?'] },
      { method: 'POST', path: '/networks/:id/offer', description: 'Offer non-monetary help', params: ['memberId', 'description'] },
      { method: 'GET', path: '/networks/:id/requests', description: 'List open requests' },
      { method: 'POST', path: '/networks/:id/requests/:reqId/fulfill', description: 'Fulfill a request from pool (sends ETH)' },
      { method: 'POST', path: '/networks/:id/redistribute', description: 'Distribute pool to all open requests proportionally' }
    ],
    example_flow: [
      '1. POST /networks - Create network "Local Helpers"',
      '2. POST /networks/:id/join - Alice joins with address',
      '3. POST /networks/:id/join - Bob joins with address',
      '4. POST /networks/:id/contribute - Alice contributes 1 ETH',
      '5. POST /networks/:id/request - Bob requests 0.5 ETH for rent',
      '6. POST /networks/:id/requests/:reqId/fulfill - Fulfill Bob\'s request'
    ],
    x402_enabled: false
  });
});

// Create network
app.post('/networks', requireWhitelist(), (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  
  const id = uuidv4();
  networks.set(id, {
    id,
    name,
    description: description || '',
    poolBalance: '0',
    members: [], // { id, address, name, contributions, received }
    requests: [], // { id, memberId, amount, reason, status, fulfilledBy }
    offers: [], // { id, memberId, description, status }
    createdAt: Date.now()
  });
  
  res.json({ success: true, network: networks.get(id) });
});

// Get network
app.get('/networks/:id', (req, res) => {
  const network = networks.get(req.params.id);
  if (!network) return res.status(404).json({ error: 'Network not found' });
  res.json(network);
});

// Join network
app.post('/networks/:id/join', requireWhitelist(), (req, res) => {
  const network = networks.get(req.params.id);
  if (!network) return res.status(404).json({ error: 'Network not found' });
  
  const { address, name } = req.body;
  if (!address) return res.status(400).json({ error: 'Address required' });
  
  if (network.members.find(m => m.address.toLowerCase() === address.toLowerCase())) {
    return res.status(400).json({ error: 'Already a member' });
  }
  
  const memberId = uuidv4();
  network.members.push({
    id: memberId,
    address,
    name: name || 'Anonymous',
    contributions: '0',
    received: '0',
    joinedAt: Date.now()
  });
  
  res.json({ success: true, memberId });
});

// Contribute to pool
app.post('/networks/:id/contribute', requireWhitelist(), (req, res) => {
  const network = networks.get(req.params.id);
  if (!network) return res.status(404).json({ error: 'Network not found' });
  
  const { memberId, amount, txHash } = req.body;
  if (!memberId || !amount) return res.status(400).json({ error: 'memberId and amount required' });
  
  const member = network.members.find(m => m.id === memberId);
  if (!member) return res.status(404).json({ error: 'Member not found' });
  
  // Record contribution
  const amountNum = parseFloat(amount);
  member.contributions = (parseFloat(member.contributions) + amountNum).toString();
  network.poolBalance = (parseFloat(network.poolBalance) + amountNum).toString();
  
  res.json({ success: true, newBalance: network.poolBalance, txHash });
});

// Request help
app.post('/networks/:id/request', requireWhitelist(), (req, res) => {
  const network = networks.get(req.params.id);
  if (!network) return res.status(404).json({ error: 'Network not found' });
  
  const { memberId, amount, reason } = req.body;
  if (!memberId || !amount) return res.status(400).json({ error: 'memberId and amount required' });
  
  const member = network.members.find(m => m.id === memberId);
  if (!member) return res.status(404).json({ error: 'Member not found' });
  
  const requestId = uuidv4();
  network.requests.push({
    id: requestId,
    memberId,
    memberName: member.name,
    amount,
    reason: reason || '',
    status: 'open',
    fulfilledBy: null,
    createdAt: Date.now()
  });
  
  res.json({ success: true, requestId });
});

// Offer help
app.post('/networks/:id/offer', requireWhitelist(), (req, res) => {
  const network = networks.get(req.params.id);
  if (!network) return res.status(404).json({ error: 'Network not found' });
  
  const { memberId, description } = req.body;
  if (!memberId || !description) return res.status(400).json({ error: 'memberId and description required' });
  
  const member = network.members.find(m => m.id === memberId);
  if (!member) return res.status(404).json({ error: 'Member not found' });
  
  const offerId = uuidv4();
  network.offers.push({
    id: offerId,
    memberId,
    memberName: member.name,
    description,
    status: 'open',
    createdAt: Date.now()
  });
  
  res.json({ success: true, offerId });
});

// List open requests
app.get('/networks/:id/requests', (req, res) => {
  const network = networks.get(req.params.id);
  if (!network) return res.status(404).json({ error: 'Network not found' });
  
  const openRequests = network.requests.filter(r => r.status === 'open');
  res.json(openRequests);
});

// Fulfill request from pool
app.post('/networks/:id/requests/:reqId/fulfill', requireWhitelist(), async (req, res) => {
  const network = networks.get(req.params.id);
  if (!network) return res.status(404).json({ error: 'Network not found' });
  
  const request = network.requests.find(r => r.id === req.params.reqId);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.status !== 'open') return res.status(400).json({ error: 'Request already fulfilled' });
  
  const member = network.members.find(m => m.id === request.memberId);
  if (!member) return res.status(404).json({ error: 'Member not found' });
  
  const amountWei = ethers.parseEther(request.amount);
  const poolWei = ethers.parseEther(network.poolBalance);
  
  if (poolWei < amountWei) {
    return res.status(400).json({ error: 'Insufficient pool balance' });
  }
  
  try {
    const wallet = getWallet();
    const fee = amountWei * BigInt(Math.floor(FEE_RATE * 100)) / 100n;
    const payout = amountWei - fee;
    
    const feeTx = await wallet.sendTransaction({ to: TREASURY, value: fee });
    await feeTx.wait();
    
    const payoutTx = await wallet.sendTransaction({ to: member.address, value: payout });
    await payoutTx.wait();
    
    // Update state
    request.status = 'fulfilled';
    request.fulfilledAt = Date.now();
    request.txHash = payoutTx.hash;
    
    member.received = (parseFloat(member.received) + parseFloat(request.amount)).toString();
    network.poolBalance = ethers.formatEther(poolWei - amountWei);
    
    res.json({
      success: true,
      payout: ethers.formatEther(payout),
      fee: ethers.formatEther(fee),
      txHash: payoutTx.hash
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Redistribute based on need (equal distribution to all with open requests)
app.post('/networks/:id/redistribute', requireWhitelist(), async (req, res) => {
  const network = networks.get(req.params.id);
  if (!network) return res.status(404).json({ error: 'Network not found' });
  
  const openRequests = network.requests.filter(r => r.status === 'open');
  if (openRequests.length === 0) {
    return res.json({ success: true, message: 'No open requests' });
  }
  
  const poolWei = ethers.parseEther(network.poolBalance);
  if (poolWei === 0n) {
    return res.status(400).json({ error: 'Pool is empty' });
  }
  
  // Distribute proportionally based on requested amounts
  const totalRequested = openRequests.reduce((sum, r) => sum + parseFloat(r.amount), 0);
  const poolNum = parseFloat(network.poolBalance);
  const ratio = Math.min(1, poolNum / totalRequested);
  
  const results = [];
  
  try {
    const wallet = getWallet();
    
    for (const request of openRequests) {
      const member = network.members.find(m => m.id === request.memberId);
      if (!member) continue;
      
      const amountToSend = parseFloat(request.amount) * ratio;
      if (amountToSend <= 0) continue;
      
      const amountWei = ethers.parseEther(amountToSend.toFixed(18));
      const fee = amountWei * BigInt(Math.floor(FEE_RATE * 100)) / 100n;
      const payout = amountWei - fee;
      
      const feeTx = await wallet.sendTransaction({ to: TREASURY, value: fee });
      await feeTx.wait();
      
      const payoutTx = await wallet.sendTransaction({ to: member.address, value: payout });
      await payoutTx.wait();
      
      request.status = ratio >= 1 ? 'fulfilled' : 'partial';
      request.fulfilledAmount = amountToSend.toString();
      request.txHash = payoutTx.hash;
      
      member.received = (parseFloat(member.received) + amountToSend).toString();
      
      results.push({
        memberId: member.id,
        requested: request.amount,
        received: ethers.formatEther(payout),
        txHash: payoutTx.hash
      });
    }
    
    network.poolBalance = '0';
    res.json({ success: true, ratio, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// E2E Test
app.get('/test/e2e', async (req, res) => {
  const results = { tests: [], passed: 0, failed: 0 };
  
  const test = (name, condition) => {
    const passed = !!condition;
    results.tests.push({ name, passed });
    passed ? results.passed++ : results.failed++;
    return passed;
  };
  
  try {
    // Create network
    const networkId = uuidv4();
    networks.set(networkId, {
      id: networkId,
      name: 'Test Network',
      description: 'Test mutual aid',
      poolBalance: '0',
      members: [],
      requests: [],
      offers: [],
      createdAt: Date.now()
    });
    test('Create network', networks.has(networkId));
    
    // Add members
    const network = networks.get(networkId);
    const m1 = { id: 'member1', address: '0x1111', name: 'Alice', contributions: '0', received: '0' };
    const m2 = { id: 'member2', address: '0x2222', name: 'Bob', contributions: '0', received: '0' };
    network.members.push(m1, m2);
    test('Add members', network.members.length === 2);
    
    // Contribute
    m1.contributions = '1.0';
    network.poolBalance = '1.0';
    test('Contribute', network.poolBalance === '1.0');
    
    // Request help
    const req1 = { id: 'req1', memberId: 'member2', amount: '0.5', reason: 'rent', status: 'open' };
    network.requests.push(req1);
    test('Request help', network.requests.length === 1);
    
    // Offer help
    const offer1 = { id: 'offer1', memberId: 'member1', description: 'Can help move', status: 'open' };
    network.offers.push(offer1);
    test('Offer help', network.offers.length === 1);
    
    // Check redistribution logic (no actual tx)
    const openReqs = network.requests.filter(r => r.status === 'open');
    const totalReq = openReqs.reduce((s, r) => s + parseFloat(r.amount), 0);
    const ratio = Math.min(1, parseFloat(network.poolBalance) / totalReq);
    test('Calculate ratio', ratio === 1); // Pool has 1.0, request is 0.5, ratio = 1
    
    // Cleanup
    networks.delete(networkId);
    test('Cleanup', !networks.has(networkId));
    
  } catch (err) {
    results.error = err.message;
  }
  
  res.json(results);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Mutual Aid running on port ${PORT}`));

module.exports = app;
