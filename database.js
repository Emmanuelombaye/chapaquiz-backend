const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('CRITICAL ERROR: Supabase credentials are not defined in the environment variables!');
}

const WebSocket = require('ws');

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false
  },
  realtime: {
    transport: WebSocket
  }
});

async function initDb() {
  console.log('Connecting to Supabase and checking questions database...');
  try {
    const { count, error } = await supabase
      .from('questions')
      .select('*', { count: 'exact', head: true });
      
    if (error) {
      console.error('Error connecting to Supabase questions table. Make sure you ran the SQL schema in Supabase Editor:', error.message);
      return;
    }

    const defaultQs = require('./questions');
    
    if (count === null || count < defaultQs.length) {
      console.log(`Questions table has ${count} questions (target: ${defaultQs.length}). Syncing default questions into Supabase...`);
      
      // Seed in batches of 50 to avoid request body size limits
      for (let i = 0; i < defaultQs.length; i += 50) {
        const batch = defaultQs.slice(i, i + 50).map(q => ({
          id: q.id,
          text: q.text,
          options: q.options,
          correct_answer: q.correctAnswer
        }));
        
        let retries = 3;
        while (retries > 0) {
          try {
            const { error: insertErr } = await supabase.from('questions').upsert(batch, { onConflict: 'id' });
            if (insertErr) throw insertErr;
            break; // success
          } catch (batchErr) {
            retries--;
            if (retries === 0) {
              console.error(`Failed to sync batch starting at index ${i}:`, batchErr.message || batchErr);
              throw batchErr;
            }
            console.warn(`Transient fetch failure, retrying batch starting at index ${i} (${retries} retries left)...`);
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
      }
      console.log(`Successfully synced ${defaultQs.length} default questions into Supabase database.`);
    } else {
      console.log(`Supabase questions table initialized. Existing question count: ${count}`);
    }
  } catch (err) {
    console.error('Failed to initialize/seed Supabase questions:', err.message || err);
  }
}

// User functions
async function getUser(userId) {
  const { data, error } = await supabase.from('users').select('*').eq('id', userId).maybeSingle();
  if (error) throw error;
  return data;
}

async function getUserByPhone(phone) {
  const { data, error } = await supabase.from('users').select('*').eq('phone', phone).maybeSingle();
  if (error) throw error;
  return data;
}

async function createUser(id, name, phone) {
  const { data, error } = await supabase.from('users').insert({
    id,
    name,
    phone,
    wallet_balance: 0.0
  }).select().single();
  if (error) throw error;
  return data;
}

async function updateUserName(userId, name) {
  const { data, error } = await supabase.from('users').update({ name }).eq('id', userId).select().single();
  if (error) throw error;
  return data;
}

async function updateUserBalance(userId, amount) {
  const user = await getUser(userId);
  if (!user) throw new Error('User not found');
  const newBalance = user.wallet_balance + amount;
  const { data, error } = await supabase.from('users').update({ wallet_balance: newBalance }).eq('id', userId).select().single();
  if (error) throw error;
  return data;
}

// Match functions
async function createMatch(id, entryFee, isPrivate, questionsJson, status = 'waiting', timerStart = null) {
  const questionsObj = typeof questionsJson === 'string' ? JSON.parse(questionsJson) : questionsJson;
  const { error } = await supabase.from('matches').insert({
    id,
    status,
    entry_fee: entryFee,
    is_private: !!isPrivate,
    questions: questionsObj,
    timer_start: timerStart
  });
  if (error) throw error;
}

async function updateMatchStatus(matchId, status) {
  const { error } = await supabase.from('matches').update({ status }).eq('id', matchId);
  if (error) throw error;
}

async function updateMatchTimerStart(matchId, timerStart) {
  const { error } = await supabase.from('matches').update({ timer_start: timerStart }).eq('id', matchId);
  if (error) throw error;
}

async function getMatch(matchId) {
  const { data, error } = await supabase.from('matches').select('*').eq('id', matchId).maybeSingle();
  if (error) throw error;
  if (data) {
    // Convert JSONB questions array back to JSON string to match server.js SQLite expectations
    data.questions = JSON.stringify(data.questions);
  }
  return data;
}

async function getMatchPlayer(matchId, userId) {
  const { data, error } = await supabase
    .from('match_players')
    .select('*')
    .eq('match_id', matchId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function addMatchPlayer(matchId, userId) {
  const { error } = await supabase.from('match_players').upsert({
    match_id: matchId,
    user_id: userId
  }, { onConflict: 'match_id,user_id' });
  if (error && error.code !== '23505') throw error;
}

async function updatePlayerResult(matchId, userId, score, timeTaken) {
  const { error } = await supabase.from('match_players').update({
    score,
    time_taken: timeTaken,
    is_finished: true
  }).eq('match_id', matchId).eq('user_id', userId);
  if (error) throw error;
}

async function updatePlayerScore(matchId, userId, score) {
  const { error } = await supabase.from('match_players').update({ score }).eq('match_id', matchId).eq('user_id', userId);
  if (error) throw error;
}

async function getMatchPlayers(matchId) {
  const { data, error } = await supabase
    .from('match_players')
    .select('*, users(name)')
    .eq('match_id', matchId);
  if (error) throw error;
  return data.map(item => ({
    match_id: item.match_id,
    user_id: item.user_id,
    score: item.score,
    time_taken: item.time_taken,
    is_finished: item.is_finished ? 1 : 0,
    name: item.users ? item.users.name : 'Unknown'
  }));
}

// Leaderboard
async function getGlobalRanks() {
  const { data, error } = await supabase
    .from('users')
    .select('id, name, wallet_balance')
    .order('wallet_balance', { ascending: false })
    .limit(10);
  if (error) throw error;
  return data;
}

// Transactions
async function createTransaction(id, userId, type, amount, status, mpesaCode) {
  const { error } = await supabase.from('transactions').insert({
    id,
    user_id: userId,
    type,
    amount,
    status,
    mpesa_code: mpesaCode
  });
  if (error) throw error;
}

async function getTransactionHistory(userId) {
  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw error;
  return data;
}

// Queue functions
async function joinQueue(userId, tier) {
  const { error } = await supabase.from('match_queue').upsert({
    user_id: userId,
    tier
  }, { onConflict: 'user_id' });
  if (error) throw error;
}

async function leaveQueue(userId) {
  const { error } = await supabase.from('match_queue').delete().eq('user_id', userId);
  if (error) throw error;
}

async function getQueuePlayers(tier) {
  const { data, error } = await supabase
    .from('match_queue')
    .select('*')
    .eq('tier', tier)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

async function deleteQueuePlayers(userIds) {
  const { error } = await supabase.from('match_queue').delete().in('user_id', userIds);
  if (error) throw error;
}

// Private Room functions
async function createPrivateRoom(id, hostUserId, entryFee) {
  const { error } = await supabase.from('private_rooms').insert({
    id,
    host_user_id: hostUserId,
    entry_fee: entryFee,
    status: 'waiting'
  });
  if (error) throw error;
}

async function getPrivateRoom(roomId) {
  const { data, error } = await supabase.from('private_rooms').select('*').eq('id', roomId).maybeSingle();
  if (error) throw error;
  return data;
}

async function addPrivateRoomPlayer(roomId, userId) {
  const { error } = await supabase.from('private_room_players').upsert({
    room_id: roomId,
    user_id: userId
  }, { onConflict: 'room_id,user_id' });
  if (error && error.code !== '23505') throw error;
}

async function getPrivateRoomPlayers(roomId) {
  const { data, error } = await supabase
    .from('private_room_players')
    .select('user_id, users(name)')
    .eq('room_id', roomId);
  if (error) throw error;
  return data.map(item => ({
    userId: item.user_id,
    name: item.users ? item.users.name : 'Unknown'
  }));
}

async function startPrivateRoom(roomId, matchId) {
  const { error } = await supabase.from('private_rooms').update({
    status: 'started',
    match_id: matchId
  }).eq('id', roomId);
  if (error) throw error;
}

// Check if user is in any live match
async function getUserLiveMatch(userId) {
  const { data, error } = await supabase
    .from('match_players')
    .select('matches(*)')
    .eq('user_id', userId)
    .in('matches.status', ['waiting', 'live']);
  if (error) throw error;
  if (data && data.length > 0) {
    const match = data.map(d => d.matches).filter(Boolean)[0];
    if (match) {
      match.questions = JSON.stringify(match.questions);
      return match;
    }
  }
  return null;
}

// Admin Helpers
async function getAdminStats() {
  const { count: totalUsers, error: usersErr } = await supabase
    .from('users')
    .select('*', { count: 'exact', head: true });
  if (usersErr) throw usersErr;

  const { data: balanceData, error: balanceErr } = await supabase
    .from('users')
    .select('wallet_balance');
  if (balanceErr) throw balanceErr;
  const totalBalance = balanceData.reduce((sum, u) => sum + (u.wallet_balance || 0), 0);

  const { count: activeMatches, error: matchesErr } = await supabase
    .from('matches')
    .select('*', { count: 'exact', head: true })
    .in('status', ['live', 'waiting']);
  if (matchesErr) throw matchesErr;

  // Platform fees = 20% of pot of all finished matches
  const { data: finishedMatches, error: finishedErr } = await supabase
    .from('matches')
    .select('id, entry_fee')
    .eq('status', 'finished');
  if (finishedErr) throw finishedErr;

  let platformFees = 0;
  if (finishedMatches && finishedMatches.length > 0) {
    const matchIds = finishedMatches.map(m => m.id);
    const { data: playersData, error: playersErr } = await supabase
      .from('match_players')
      .select('match_id')
      .in('match_id', matchIds);
    if (playersErr) throw playersErr;

    finishedMatches.forEach(m => {
      const playerCount = playersData.filter(p => p.match_id === m.id).length;
      platformFees += m.entry_fee * playerCount * 0.20;
    });
  }

  return {
    totalUsers: totalUsers || 0,
    totalBalance: Math.round(totalBalance * 100) / 100,
    platformFees: Math.round(platformFees * 100) / 100,
    activeMatches: activeMatches || 0
  };
}

async function getAdminUsers(query = '') {
  let req = supabase.from('users').select('*');
  if (query.trim().length > 0) {
    req = req.or(`name.ilike.%${query}%,phone.ilike.%${query}%`);
  }
  const { data, error } = await req.order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

async function getAdminTransactions() {
  const { data, error } = await supabase
    .from('transactions')
    .select('*, users(name, phone)')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return data.map(tx => ({
    id: tx.id,
    user_id: tx.user_id,
    type: tx.type,
    amount: tx.amount,
    status: tx.status,
    mpesa_code: tx.mpesa_code,
    created_at: tx.created_at,
    user_name: tx.users ? tx.users.name : 'Unknown',
    user_phone: tx.users ? tx.users.phone : ''
  }));
}

async function getAdminMatches() {
  const { data, error } = await supabase
    .from('matches')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(25);
  if (error) throw error;

  if (data && data.length > 0) {
    const matchIds = data.map(m => m.id);
    const { data: playersData, error: playersErr } = await supabase
      .from('match_players')
      .select('match_id')
      .in('match_id', matchIds);
    if (playersErr) throw playersErr;

    return data.map(m => ({
      ...m,
      player_count: playersData.filter(p => p.match_id === m.id).length
    }));
  }
  return [];
}

// Question management
async function getRandomQuestions() {
  const { data: qIds, error: idErr } = await supabase.from('questions').select('id');
  if (idErr) throw idErr;
  if (!qIds || qIds.length === 0) return [];
  
  const shuffled = qIds.sort(() => 0.5 - Math.random());
  const selectedIds = shuffled.slice(0, 5).map(q => q.id);
  
  const { data, error } = await supabase.from('questions').select('*').in('id', selectedIds);
  if (error) throw error;
  
  return data.map(r => ({
    id: r.id,
    text: r.text,
    options: r.options,
    correctAnswer: r.correct_answer
  })).sort(() => 0.5 - Math.random());
}

async function getQuestions() {
  const { data, error } = await supabase.from('questions').select('*').order('id', { ascending: true });
  if (error) throw error;
  return data.map(r => ({
    id: r.id,
    text: r.text,
    options: r.options,
    correctAnswer: r.correct_answer
  }));
}

async function createQuestion(id, text, optionsArray, correctAnswer) {
  const { error } = await supabase.from('questions').insert({
    id,
    text,
    options: optionsArray,
    correct_answer: correctAnswer
  });
  if (error) throw error;
}

async function updateQuestion(id, text, optionsArray, correctAnswer) {
  const { error } = await supabase.from('questions').update({
    text,
    options: optionsArray,
    correct_answer: correctAnswer
  }).eq('id', id);
  if (error) throw error;
}

async function deleteQuestion(id) {
  const { error } = await supabase.from('questions').delete().eq('id', id);
  if (error) throw error;
}

// Admin login check against Supabase admin_credentials table
async function adminLoginCheck(email, password) {
  try {
    const { data, error } = await supabase
      .from('admin_credentials')
      .select('*')
      .eq('email', email)
      .eq('password', password)
      .maybeSingle();
    if (error) throw error;
    return !!data;
  } catch (err) {
    console.error('Failed admin credential check:', err);
    return false;
  }
}

module.exports = {
  initDb,
  getUser,
  getUserByPhone,
  createUser,
  updateUserName,
  updateUserBalance,
  createMatch,
  updateMatchStatus,
  updateMatchTimerStart,
  getMatch,
  getMatchPlayer,
  addMatchPlayer,
  updatePlayerResult,
  updatePlayerScore,
  getMatchPlayers,
  getGlobalRanks,
  createTransaction,
  getTransactionHistory,
  joinQueue,
  leaveQueue,
  getQueuePlayers,
  deleteQueuePlayers,
  createPrivateRoom,
  getPrivateRoom,
  addPrivateRoomPlayer,
  getPrivateRoomPlayers,
  startPrivateRoom,
  getUserLiveMatch,
  getAdminStats,
  getAdminUsers,
  getAdminTransactions,
  getAdminMatches,
  getRandomQuestions,
  getQuestions,
  createQuestion,
  updateQuestion,
  deleteQuestion,
  adminLoginCheck
};
