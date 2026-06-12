const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const dotenv = require('dotenv');
const crypto = require('crypto');
const db = require('./database');
const questionBank = require('./questions');

dotenv.config();

let cachedQuestions = [];
const userToMatchMap = {};

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*', // Allow all origins for dev/simplicity
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());

// Initialize Database asynchronously in startServer()

// Generate unique ID utility
const generateId = () => crypto.randomBytes(8).toString('hex');

// REST API Endpoints

// Authentication
app.post('/api/auth/login', async (req, res) => {
  const { phone, name, action } = req.body;
  if (!phone) {
    return res.status(400).json({ error: 'Phone number is required' });
  }
  
  try {
    let user = await db.getUserByPhone(phone);
    if (action === 'login') {
      if (!user) {
        return res.status(404).json({ error: 'Account not found. Please register / create an account first.' });
      }
      res.json(user);
    } else if (action === 'register') {
      if (user) {
        return res.status(400).json({ error: 'This phone number is already registered. Please log in instead.' });
      }
      const id = generateId();
      user = await db.createUser(id, name || `Player_${phone.slice(-4)}`, phone);
      res.json(user);
    } else {
      // Legacy find-or-create fallback
      if (!user) {
        const id = generateId();
        user = await db.createUser(id, name || `Player_${phone.slice(-4)}`, phone);
      }
      res.json(user);
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Admin Authentication
app.post('/api/admin/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const isValid = await db.adminLoginCheck(email, password);
    if (isValid) {
      res.json({ success: true });
    } else {
      res.status(401).json({ error: 'Access Denied. Invalid Administrator credentials.' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Profile
app.get('/api/user/profile/:id', async (req, res) => {
  try {
    const user = await db.getUser(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/user/profile/:id', async (req, res) => {
  const { name } = req.body;
  if (!name || name.trim().length === 0) {
    return res.status(400).json({ error: 'Name is required' });
  }
  try {
    const user = await db.updateUserName(req.params.id, name.trim());
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Wallet Balance
app.get('/api/wallet/balance/:id', async (req, res) => {
  try {
    const user = await db.getUser(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ balance: user.wallet_balance });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Wallet Deposit (M-Pesa STK Push Simulation)
app.post('/api/wallet/deposit', async (req, res) => {
  const { userId, amount, phone, pin } = req.body;
  if (!userId || !amount || !phone || !pin) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  try {
    // Simulate payment transaction
    const user = await db.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const txId = generateId().toUpperCase();
    const mpesaCode = 'MP' + Math.random().toString(36).substring(2, 10).toUpperCase();
    
    // Add funds to balance
    await db.updateUserBalance(userId, amount);
    // Log transaction
    await db.createTransaction(txId, userId, 'deposit', amount, 'completed', mpesaCode);

    res.json({
      success: true,
      transactionId: txId,
      mpesaCode,
      newBalance: user.wallet_balance + amount
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Wallet Withdrawal
app.post('/api/wallet/withdraw', async (req, res) => {
  const { userId, amount, phone } = req.body;
  if (!userId || !amount || !phone) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  try {
    const user = await db.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.wallet_balance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    const txId = generateId().toUpperCase();
    const mpesaCode = 'MPW' + Math.random().toString(36).substring(2, 10).toUpperCase();

    // Deduct funds
    await db.updateUserBalance(userId, -amount);
    // Log transaction
    await db.createTransaction(txId, userId, 'withdrawal', amount, 'completed', mpesaCode);

    res.json({
      success: true,
      transactionId: txId,
      mpesaCode,
      newBalance: user.wallet_balance - amount
    });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Transaction History
app.get('/api/wallet/transactions/:userId', async (req, res) => {
  try {
    const txs = await db.getTransactionHistory(req.params.userId);
    res.json(txs);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Admin Dashboard endpoints
app.get('/api/admin/stats', async (req, res) => {
  try {
    const stats = await db.getAdminStats();
    res.json(stats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/admin/users', async (req, res) => {
  const query = req.query.query || '';
  try {
    const users = await db.getAdminUsers(query);
    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/admin/users/:id/adjust-balance', async (req, res) => {
  const { id } = req.params;
  const { amount } = req.body;
  if (amount === undefined || isNaN(Number(amount))) {
    return res.status(400).json({ error: 'Invalid amount' });
  }
  
  try {
    const user = await db.getUser(id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    await db.updateUserBalance(id, Number(amount));
    const txId = generateId().toUpperCase();
    await db.createTransaction(
      txId, 
      id, 
      Number(amount) >= 0 ? 'deposit' : 'withdrawal', 
      Math.abs(Number(amount)), 
      'completed', 
      'ADMIN_ADJ'
    );
    
    res.json({ success: true, newBalance: user.wallet_balance + Number(amount) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/admin/transactions', async (req, res) => {
  try {
    const txs = await db.getAdminTransactions();
    res.json(txs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/admin/matches', async (req, res) => {
  try {
    const matches = await db.getAdminMatches();
    res.json(matches);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/admin/questions', async (req, res) => {
  try {
    const qs = await db.getQuestions();
    res.json(qs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/admin/questions', async (req, res) => {
  const { text, options, correctAnswer } = req.body;
  if (!text || !options || options.length !== 4 || correctAnswer === undefined) {
    return res.status(400).json({ error: 'Missing or invalid parameters' });
  }
  
  try {
    const id = 'q_' + generateId();
    await db.createQuestion(id, text, options, Number(correctAnswer));
    await loadQuestionsCache();
    res.json({ success: true, id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.put('/api/admin/questions/:id', async (req, res) => {
  const { id } = req.params;
  const { text, options, correctAnswer } = req.body;
  if (!text || !options || options.length !== 4 || correctAnswer === undefined) {
    return res.status(400).json({ error: 'Missing or invalid parameters' });
  }
  
  try {
    await db.updateQuestion(id, text, options, Number(correctAnswer));
    await loadQuestionsCache();
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.delete('/api/admin/questions/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await db.deleteQuestion(id);
    await loadQuestionsCache();
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Leaderboard Ranks
app.get('/api/leaderboard', async (req, res) => {
  try {
    const ranks = await db.getGlobalRanks();
    res.json(ranks);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Load questions from DB into cache
async function loadQuestionsCache() {
  try {
    cachedQuestions = await db.getQuestions();
    console.log(`Questions cache initialized with ${cachedQuestions.length} questions.`);
  } catch (err) {
    console.error('Failed to load questions cache:', err);
  }
}

// Initialize queues from DB on startup
async function loadQueuesFromDb() {
  try {
    for (const tier of Object.keys(queues)) {
      queues[tier] = [];
      const dbPlayers = await db.getQueuePlayers(Number(tier));
      for (const p of dbPlayers) {
        const user = await db.getUser(p.user_id);
        if (user) {
          queues[tier].push({
            userId: user.id,
            name: user.name,
            socketId: null
          });
        }
      }
    }
    console.log('Queues loaded from database.');
  } catch (err) {
    console.error('Failed to load queues from DB:', err);
  }
}

// REST Matchmaking and Gameplay API Endpoints

// Join Queue REST
app.post('/api/queue/join', async (req, res) => {
  const { userId, tier } = req.body;
  if (!userId || !tier) {
    return res.status(400).json({ error: 'Missing params' });
  }
  const entryFee = Number(tier);

  try {
    const user = await db.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.wallet_balance < entryFee) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // Check if already in live match
    const existingMatch = await db.getUserLiveMatch(userId);
    if (existingMatch) {
      const questions = JSON.parse(existingMatch.questions);
      return res.json({
        status: 'matched',
        matchId: existingMatch.id,
        questions: questions.map(({ id, text, options }) => ({ id, text, options })),
        timerStart: existingMatch.timer_start
      });
    }

    // Add to in-memory queues
    const alreadyInQueue = queues[entryFee].some(p => p.userId === userId);
    if (!alreadyInQueue) {
      queues[entryFee].push({
        userId: user.id,
        name: user.name,
        socketId: null
      });
      await db.joinQueue(userId, entryFee);
    }

    // Matchmaking logic
    if (queues[entryFee].length >= 3) {
      const players = queues[entryFee].splice(0, 3);
      const matchId = 'M_' + generateId().toUpperCase();
      const questions = await getRandomQuestions();
      const timerStart = new Date().toISOString();

      await db.createMatch(matchId, entryFee, false, JSON.stringify(questions), 'live', timerStart);

      for (const p of players) {
        await db.updateUserBalance(p.userId, -entryFee);
        await db.createTransaction(generateId().toUpperCase(), p.userId, 'entry_fee', entryFee, 'completed', null);
        await db.addMatchPlayer(matchId, p.userId);
        await db.leaveQueue(p.userId);
        userToMatchMap[p.userId] = matchId; // Cache mapping
      }

      activeMatches[matchId] = {
        id: matchId,
        entryFee,
        questions,
        timerStart, // Store timerStart in memory
        players: players.map(p => ({
          userId: p.userId,
          socketId: null,
          name: p.name,
          score: 0,
          timeTaken: 0,
          finished: false
        })),
        timer: 60,
        intervalId: setInterval(() => {
          const match = activeMatches[matchId];
          if (!match) return;
          match.timer--;
          if (match.timer <= 0) {
            clearInterval(match.intervalId);
            endMatch(matchId);
          }
        }, 1000)
      };

      return res.json({
        status: 'matched',
        matchId,
        questions: questions.map(({ id, text, options }) => ({ id, text, options })),
        timerStart
      });
    }

    res.json({ status: 'waiting', playersInQueue: queues[entryFee].length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Leave Queue REST
app.post('/api/queue/leave', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  try {
    Object.keys(queues).forEach(tier => {
      queues[tier] = queues[tier].filter(p => p.userId !== userId);
    });
    await db.leaveQueue(userId);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Poll Queue REST
app.get('/api/queue/poll', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  try {
    // Check in-memory cache first to avoid hitting database
    const cachedMatchId = userToMatchMap[userId];
    if (cachedMatchId && activeMatches[cachedMatchId]) {
      const match = activeMatches[cachedMatchId];
      return res.json({
        matched: true,
        matchId: match.id,
        questions: match.questions.map(({ id, text, options }) => ({ id, text, options })),
        timerStart: match.timerStart
      });
    }

    const liveMatch = await db.getUserLiveMatch(userId);
    if (liveMatch) {
      if (!activeMatches[liveMatch.id]) {
        const questions = JSON.parse(liveMatch.questions);
        const matchPlayers = await db.getMatchPlayers(liveMatch.id);

        activeMatches[liveMatch.id] = {
          id: liveMatch.id,
          entryFee: liveMatch.entry_fee,
          questions,
          timerStart: liveMatch.timer_start,
          players: matchPlayers.map(p => ({
            userId: p.user_id,
            socketId: null,
            name: p.name,
            score: p.score,
            timeTaken: p.time_taken,
            finished: p.is_finished === 1
          })),
          timer: 60,
          intervalId: null
        };

        // Populate userToMatchMap for active players for self-healing
        activeMatches[liveMatch.id].players.forEach(p => {
          userToMatchMap[p.userId] = liveMatch.id;
        });

        const elapsed = (Date.now() - new Date(liveMatch.timer_start).getTime()) / 1000;
        const remaining = Math.max(0, Math.round(60 - elapsed));
        activeMatches[liveMatch.id].timer = remaining;

        if (remaining > 0) {
          activeMatches[liveMatch.id].intervalId = setInterval(async () => {
            const match = activeMatches[liveMatch.id];
            if (!match) return;
            match.timer--;
            if (match.timer <= 0) {
              clearInterval(match.intervalId);
              await endMatch(liveMatch.id);
            }
          }, 1000);
        } else {
          await endMatch(liveMatch.id);
        }
      }

      const match = activeMatches[liveMatch.id];
      return res.json({
        matched: true,
        matchId: liveMatch.id,
        questions: match.questions.map(({ id, text, options }) => ({ id, text, options })),
        timerStart: liveMatch.timer_start
      });
    }

    let inQueue = false;
    Object.keys(queues).forEach(tier => {
      if (queues[tier].some(p => p.userId === userId)) {
        inQueue = true;
      }
    });

    res.json({ matched: false, inQueue });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Create Private Match REST
app.post('/api/private/create', async (req, res) => {
  const { userId, entryFee } = req.body;
  if (!userId || !entryFee) return res.status(400).json({ error: 'Missing params' });
  const fee = Number(entryFee);

  try {
    const user = await db.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.wallet_balance < fee) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    const roomId = generateId().substring(0, 6).toUpperCase();
    await db.createPrivateRoom(roomId, userId, fee);
    await db.addPrivateRoomPlayer(roomId, userId);

    privateRooms[roomId] = {
      id: roomId,
      hostUserId: userId,
      hostSocketId: null,
      entryFee: fee,
      players: [{
        userId: user.id,
        name: user.name,
        socketId: null
      }]
    };

    res.json({ roomId, entryFee: fee });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Join Private Match REST
app.post('/api/private/:roomId/join', async (req, res) => {
  const { roomId } = req.params;
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  try {
    const room = await db.getPrivateRoom(roomId);
    if (!room) return res.status(404).json({ error: 'Private Match not found' });
    if (room.status !== 'waiting') return res.status(400).json({ error: 'Match already started' });

    const user = await db.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.wallet_balance < room.entry_fee) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    await db.addPrivateRoomPlayer(roomId, userId);

    if (!privateRooms[roomId]) {
      const prPlayers = await db.getPrivateRoomPlayers(roomId);
      privateRooms[roomId] = {
        id: roomId,
        hostUserId: room.host_user_id,
        hostSocketId: null,
        entryFee: room.entry_fee,
        players: prPlayers.map(p => ({
          userId: p.userId,
          name: p.name,
          socketId: null
        }))
      };
    } else {
      if (!privateRooms[roomId].players.some(p => p.userId === userId)) {
        privateRooms[roomId].players.push({
          userId: user.id,
          name: user.name,
          socketId: null
        });
      }
    }

    res.json({ success: true, entryFee: room.entry_fee });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get Private Room REST
app.get('/api/private/:roomId', async (req, res) => {
  const { roomId } = req.params;
  try {
    const room = await db.getPrivateRoom(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const players = await db.getPrivateRoomPlayers(roomId);
    res.json({
      roomId: room.id,
      entryFee: room.entry_fee,
      hostUserId: room.host_user_id,
      status: room.status,
      matchId: room.match_id || null,
      players: players.map(p => ({
        userId: p.userId,
        name: p.name
      }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Start Private Match REST
app.post('/api/private/:roomId/start', async (req, res) => {
  const { roomId } = req.params;
  const { userId } = req.body;

  try {
    const room = await db.getPrivateRoom(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.host_user_id !== userId) return res.status(403).json({ error: 'Not host' });

    const players = await db.getPrivateRoomPlayers(roomId);
    if (players.length < 2) {
      return res.status(400).json({ error: 'Need at least 2 players' });
    }

    const matchId = 'M_P_' + generateId().toUpperCase();
    const questions = await getRandomQuestions();
    const entryFee = room.entry_fee;
    const timerStart = new Date().toISOString();

    await db.createMatch(matchId, entryFee, true, JSON.stringify(questions), 'live', timerStart);

    for (const p of players) {
      await db.updateUserBalance(p.userId, -entryFee);
      await db.createTransaction(generateId().toUpperCase(), p.userId, 'entry_fee', entryFee, 'completed', null);
      await db.addMatchPlayer(matchId, p.userId);
      userToMatchMap[p.userId] = matchId; // Cache mapping
    }

    await db.startPrivateRoom(roomId, matchId);

    activeMatches[matchId] = {
      id: matchId,
      entryFee,
      questions,
      timerStart, // Store timerStart in memory
      players: players.map(p => ({
        userId: p.userId,
        socketId: null,
        name: p.name,
        score: 0,
        timeTaken: 0,
        finished: false
      })),
      timer: 60,
      intervalId: setInterval(async () => {
        const match = activeMatches[matchId];
        if (!match) return;
        match.timer--;
        if (match.timer <= 0) {
          clearInterval(match.intervalId);
          await endMatch(matchId);
        }
      }, 1000)
    };

    delete privateRooms[roomId];

    res.json({
      matchId,
      questions: questions.map(({ id, text, options }) => ({ id, text, options })),
      timerStart
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Submit Answer REST
app.post('/api/match/:matchId/answer', async (req, res) => {
  const { matchId } = req.params;
  const { userId, questionIndex, selectedOption } = req.body;

  try {
    let match = activeMatches[matchId];
    
    if (!match) {
      const matchRow = await db.getMatch(matchId);
      if (!matchRow || matchRow.status !== 'live') {
        return res.status(400).json({ error: 'Match not active' });
      }

      const playerRow = await db.getMatchPlayer(matchId, userId);
      if (!playerRow) return res.status(404).json({ error: 'Player not in match' });

      const questions = JSON.parse(matchRow.questions);
      const matchPlayers = await db.getMatchPlayers(matchId);

      activeMatches[matchId] = {
        id: matchId,
        entryFee: matchRow.entry_fee,
        questions,
        timerStart: matchRow.timer_start,
        players: matchPlayers.map(p => ({
          userId: p.user_id,
          socketId: null,
          name: p.name,
          score: p.score,
          timeTaken: p.time_taken,
          finished: p.is_finished === 1
        })),
        timer: 60,
        intervalId: null
      };

      activeMatches[matchId].players.forEach(p => {
        userToMatchMap[p.userId] = matchId;
      });

      const elapsed = (Date.now() - new Date(matchRow.timer_start).getTime()) / 1000;
      const remaining = Math.max(0, Math.round(60 - elapsed));
      activeMatches[matchId].timer = remaining;

      if (remaining > 0) {
        activeMatches[matchId].intervalId = setInterval(async () => {
          const match = activeMatches[matchId];
          if (!match) return;
          match.timer--;
          if (match.timer <= 0) {
            clearInterval(match.intervalId);
            await endMatch(matchId);
          }
        }, 1000);
      } else {
        await endMatch(matchId);
      }
      
      match = activeMatches[matchId];
    }

    const player = match.players.find(p => p.userId === userId);
    if (!player || player.finished) {
      return res.status(400).json({ error: 'Player already finished or not found' });
    }

    const q = match.questions[questionIndex];
    const isCorrect = q ? selectedOption === q.correctAnswer : false;
    if (isCorrect) {
      player.score++;
    }

    const isLastQuestion = questionIndex === match.questions.length - 1;
    const elapsed = match.timerStart
      ? (Date.now() - new Date(match.timerStart).getTime()) / 1000
      : 60;
    const timeTaken = Math.min(elapsed, 60);

    if (isLastQuestion) {
      player.finished = true;
      player.timeTaken = timeTaken;
      
      // Save final result to DB only when finished
      await db.updatePlayerResult(matchId, userId, player.score, player.timeTaken);

      const allFinished = match.players.every(p => p.finished);
      if (allFinished) {
        if (match.intervalId) clearInterval(match.intervalId);
        const results = await endMatch(matchId);
        return res.json({
          correct: isCorrect,
          score: player.score,
          gameOver: true,
          ...results
        });
      }

      return res.json({
        correct: isCorrect,
        score: player.score,
        gameOver: false
      });
    } else {
      // NOTE: intermediate scores are kept in memory only; no DB writes here!
      return res.json({
        correct: isCorrect,
        score: player.score,
        gameOver: false
      });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get Match Status REST
app.get('/api/match/:matchId/status', async (req, res) => {
  const { matchId } = req.params;

  try {
    // Check in-memory active matches first
    if (activeMatches[matchId]) {
      const match = activeMatches[matchId];
      return res.json({
        status: 'live',
        timerStart: match.timerStart,
        players: match.players.map(p => ({
          user_id: p.userId,
          score: p.score,
          is_finished: p.finished
        }))
      });
    }

    const matchRow = await db.getMatch(matchId);
    if (!matchRow) return res.status(404).json({ error: 'Match not found' });

    if (matchRow.status === 'live' && matchRow.timer_start) {
      const elapsed = (Date.now() - new Date(matchRow.timer_start).getTime()) / 1000;
      if (elapsed >= 60) {
        if (activeMatches[matchId] && activeMatches[matchId].intervalId) {
          clearInterval(activeMatches[matchId].intervalId);
        }
        if (!activeMatches[matchId]) {
          const questions = JSON.parse(matchRow.questions);
          const matchPlayers = await db.getMatchPlayers(matchId);
          activeMatches[matchId] = {
            id: matchId,
            entryFee: matchRow.entry_fee,
            questions,
            timerStart: matchRow.timer_start,
            players: matchPlayers.map(p => ({
              userId: p.user_id,
              socketId: null,
              name: p.name,
              score: p.score,
              timeTaken: p.time_taken,
              finished: p.is_finished === 1
            }))
          };

          activeMatches[matchId].players.forEach(p => {
            userToMatchMap[p.userId] = matchId;
          });
        }
        const result = await endMatch(matchId);
        return res.json({ status: 'finished', ...result });
      }
    }

    if (matchRow.status === 'finished') {
      const players = await db.getMatchPlayers(matchId);
      const board = players.map(p => ({
        id: p.user_id,
        name: p.name,
        score: p.score,
        time_taken: p.time_taken
      })).sort((a, b) => b.score - a.score || a.time_taken - b.time_taken);

      const totalPot = players.length * matchRow.entry_fee;
      const platformFee = totalPot * 0.20;
      const winnings = totalPot - platformFee;

      const topScore = board[0]?.score || 0;
      const topTime = board[0]?.time_taken || 0;
      const winners = board.filter(p => p.score === topScore && p.time_taken === topTime);
      const splitWinnings = winnings / (winners.length || 1);

      return res.json({
        status: 'finished',
        leaderboard: board,
        winnerId: board[0]?.id || null,
        winnerIds: winners.map(w => w.id),
        winnings: splitWinnings,
        totalPot,
        platformFee
      });
    }

    const players = await db.getMatchPlayers(matchId);
    res.json({
      status: matchRow.status,
      timerStart: matchRow.timer_start,
      players: players.map(p => ({
        user_id: p.user_id,
        score: p.score,
        is_finished: p.is_finished === 1
      }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// WebSockets Matchmaking and Gameplay State

const queues = {
  10: [],
  20: [],
  50: [],
  100: []
};

const activeMatches = {};
const privateRooms = {};

// Helper to shuffle questions
const getRandomQuestions = async () => {
  if (cachedQuestions && cachedQuestions.length > 0) {
    const shuffled = [...cachedQuestions].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, 5);
  }
  return db.getRandomQuestions();
};

io.on('connection', (socket) => {
  let authenticatedUser = null;

  // On-the-fly auth helper
  const ensureAuthenticated = async (userId) => {
    if (authenticatedUser) return authenticatedUser;
    if (!userId) return null;
    try {
      const user = await db.getUser(userId);
      if (user) {
        authenticatedUser = { userId: user.id, name: user.name, socketId: socket.id };
        console.log(`User authenticated (on-the-fly): ${user.name} (${socket.id})`);
      }
    } catch (err) {
      console.error('Error in on-the-fly socket auth:', err);
    }
    return authenticatedUser;
  };

  socket.on('auth', async (userId) => {
    await ensureAuthenticated(userId);
  });

  // Public Matchmaking Queue Join
  socket.on('join_queue', async ({ tier, userId }) => {
    const auth = await ensureAuthenticated(userId);
    if (!auth) return;
    const entryFee = Number(tier);
    
    try {
      const user = await db.getUser(auth.userId);
      if (!user || user.wallet_balance < entryFee) {
        socket.emit('error', 'Insufficient balance');
        return;
      }

      // Check if already in queue
      if (queues[entryFee].find(p => p.userId === user.id)) {
        return;
      }

      queues[entryFee].push({
        userId: user.id,
        name: user.name,
        socketId: socket.id
      });

      socket.join(`queue_${entryFee}`);
      console.log(`User ${user.name} joined queue for KSh ${entryFee}`);

      // Broadcast updated count
      io.to(`queue_${entryFee}`).emit('queue_update', {
        playersCount: queues[entryFee].length,
        targetPlayers: 3 // Set match size to 3 for real multiplayer feel
      });

      // If we have enough players, form a match
      if (queues[entryFee].length >= 3) {
        const players = queues[entryFee].splice(0, 3);
        const matchId = 'M_' + generateId().toUpperCase();
        const questions = await getRandomQuestions();
        const timerStart = new Date().toISOString();
        
        // Remove players from queue room
        players.forEach(p => {
          const s = io.sockets.sockets.get(p.socketId);
          if (s) s.leave(`queue_${entryFee}`);
        });

        // Initialize Match in DB
        await db.createMatch(matchId, entryFee, false, JSON.stringify(questions), 'live', timerStart);

        // Process entry fees and add to match
        for (const p of players) {
          await db.updateUserBalance(p.userId, -entryFee);
          await db.createTransaction(generateId().toUpperCase(), p.userId, 'entry_fee', entryFee, 'completed', null);
          await db.addMatchPlayer(matchId, p.userId);
          userToMatchMap[p.userId] = matchId; // Cache mapping
        }

        // Create match loop state
        activeMatches[matchId] = {
          id: matchId,
          entryFee,
          questions,
          timerStart, // Save timerStart
          players: players.map(p => ({
            userId: p.userId,
            socketId: p.socketId,
            name: p.name,
            score: 0,
            timeTaken: 0,
            finished: false
          })),
          timer: 60,
          intervalId: null
        };

        // Notify players match starts in 1s
        players.forEach(p => {
          io.to(p.socketId).emit('match_found', {
            matchId,
            targetPlayers: 3,
            entryFee,
            // Exclude correctAnswer for security
            questions: questions.map(({ id, text, options }) => ({ id, text, options }))
          });
        });

        console.log(`Match ${matchId} started with players: ${players.map(p => p.name).join(', ')}`);

        // Start Match Global Timer
        activeMatches[matchId].intervalId = setInterval(async () => {
          const match = activeMatches[matchId];
          if (!match) return;
          
          match.timer--;
          
          match.players.forEach(p => {
            io.to(p.socketId).emit('timer_tick', { timeLeft: match.timer });
          });

          if (match.timer <= 0) {
            clearInterval(match.intervalId);
            await endMatch(matchId);
          }
        }, 1000);
      }
    } catch (err) {
      console.error(err);
      socket.emit('error', 'Matchmaking error');
    }
  });

  // Submit Answer
  socket.on('submit_answer', async ({ matchId, questionIndex, selectedOption, userId }) => {
    const match = activeMatches[matchId];
    if (!match) return;

    let player = match.players.find(p => p.socketId === socket.id);
    if (!player && userId) {
      // Re-map socket.id to support players reconnecting or refreshing the page
      player = match.players.find(p => p.userId === userId);
      if (player) {
        player.socketId = socket.id;
        console.log(`Re-mapped socket for player ${player.name} to ${socket.id}`);
      }
    }
    
    if (!player || player.finished) return;

    const q = match.questions[questionIndex];
    const isCorrect = q ? selectedOption === q.correctAnswer : false;
    if (isCorrect) {
      player.score++;
    }

    // If final question answered
    if (questionIndex === 4) {
      player.finished = true;
      player.timeTaken = 60 - match.timer;
      
      // Save result to DB
      await db.updatePlayerResult(matchId, player.userId, player.score, player.timeTaken);

      socket.emit('answer_result', {
        questionIndex,
        correct: isCorrect,
        score: player.score,
        gameOver: true
      });

      // Check if everyone finished
      const allFinished = match.players.every(p => p.finished);
      if (allFinished) {
        clearInterval(match.intervalId);
        await endMatch(matchId);
      }
    } else {
      socket.emit('answer_result', {
        questionIndex,
        correct: isCorrect,
        score: player.score,
        gameOver: false
      });
    }
  });

  // Create Private Match Room
  socket.on('create_private', async ({ tier, userId }) => {
    const auth = await ensureAuthenticated(userId);
    if (!auth) return;
    const entryFee = Number(tier);

    try {
      const user = await db.getUser(auth.userId);
      if (!user || user.wallet_balance < entryFee) {
        socket.emit('error', 'Insufficient balance');
        return;
      }

      const roomId = generateId().substring(0, 6).toUpperCase();
      privateRooms[roomId] = {
        id: roomId,
        hostUserId: user.id,
        hostSocketId: socket.id,
        entryFee,
        players: [{
          userId: user.id,
          name: user.name,
          socketId: socket.id
        }]
      };

      socket.join(`room_${roomId}`);
      socket.emit('private_created', { roomId, entryFee });
      console.log(`Private Room ${roomId} created by ${user.name}`);
    } catch (err) {
      console.error(err);
    }
  });

  // Join Private Room
  socket.on('join_private', async ({ roomId, userId }) => {
    const auth = await ensureAuthenticated(userId);
    if (!auth) return;
    
    let room = privateRooms[roomId];
    if (!room) {
      // Self-heal room cache from remote database
      try {
        const dbRoom = await db.getPrivateRoom(roomId);
        if (dbRoom && dbRoom.status === 'waiting') {
          const prPlayers = await db.getPrivateRoomPlayers(roomId);
          privateRooms[roomId] = {
            id: roomId,
            hostUserId: dbRoom.host_user_id,
            hostSocketId: null,
            entryFee: dbRoom.entry_fee,
            players: prPlayers.map(p => ({
              userId: p.userId,
              name: p.name,
              socketId: null
            }))
          };
          room = privateRooms[roomId];
        }
      } catch (dbErr) {
        console.error('Failed to self-heal private room cache:', dbErr);
      }
    }
    
    if (!room) {
      socket.emit('error', 'Private Match not found');
      return;
    }

    try {
      const user = await db.getUser(auth.userId);
      if (!user || user.wallet_balance < room.entryFee) {
        socket.emit('error', 'Insufficient balance');
        return;
      }

      // Check if already in room
      const existingPlayer = room.players.find(p => p.userId === user.id);
      if (existingPlayer) {
        existingPlayer.socketId = socket.id;
      } else {
        room.players.push({
          userId: user.id,
          name: user.name,
          socketId: socket.id
        });
      }

      if (room.hostUserId === user.id) {
        room.hostSocketId = socket.id;
      }

      socket.join(`room_${roomId}`);
      io.to(`room_${roomId}`).emit('private_update', {
        players: room.players.map(p => ({ userId: p.userId, name: p.name })),
        entryFee: room.entryFee
      });
      
      console.log(`User ${user.name} joined Private Room ${roomId}`);
    } catch (err) {
      console.error(err);
    }
  });

  // Start Private Match
  socket.on('start_private', async ({ roomId, userId }) => {
    const auth = await ensureAuthenticated(userId);
    if (!auth) return;
    const room = privateRooms[roomId];
    if (!room || room.hostUserId !== auth.userId) return;

    try {
      const matchId = 'M_P_' + generateId().toUpperCase();
      const questions = await getRandomQuestions();
      const entryFee = room.entryFee;
      const players = room.players;
      const timerStart = new Date().toISOString();

      // Initialize match in DB
      await db.createMatch(matchId, entryFee, true, JSON.stringify(questions), 'live', timerStart);

      // Deduct entry fees
      for (const p of players) {
        await db.updateUserBalance(p.userId, -entryFee);
        await db.createTransaction(generateId().toUpperCase(), p.userId, 'entry_fee', entryFee, 'completed', null);
        await db.addMatchPlayer(matchId, p.userId);
        userToMatchMap[p.userId] = matchId; // Cache mapping
      }

      // Update private room status in DB to start it, and keep db synced
      await db.startPrivateRoom(roomId, matchId);

      // Initialize match loop state
      activeMatches[matchId] = {
        id: matchId,
        entryFee,
        questions,
        timerStart, // Save timerStart
        players: players.map(p => ({
          userId: p.userId,
          socketId: p.socketId,
          name: p.name,
          score: 0,
          timeTaken: 0,
          finished: false
        })),
        timer: 60,
        intervalId: null
      };

      // Notify clients
      players.forEach(p => {
        io.to(p.socketId).emit('match_found', {
          matchId,
          targetPlayers: players.length,
          entryFee,
          questions: questions.map(({ id, text, options }) => ({ id, text, options }))
        });
      });

      // Cleanup room
      delete privateRooms[roomId];

      // Start Private Match Timer
      activeMatches[matchId].intervalId = setInterval(async () => {
        const match = activeMatches[matchId];
        if (!match) return;
        
        match.timer--;
        
        match.players.forEach(p => {
          io.to(p.socketId).emit('timer_tick', { timeLeft: match.timer });
        });

        if (match.timer <= 0) {
          clearInterval(match.intervalId);
          await endMatch(matchId);
        }
      }, 1000);

    } catch (err) {
      console.error(err);
    }
  });

  // Handle Disconnects
  socket.on('disconnect', () => {
    if (!authenticatedUser) return;
    console.log(`User disconnected: ${authenticatedUser.name}`);

    // Remove from queues
    Object.keys(queues).forEach(tier => {
      queues[tier] = queues[tier].filter(p => p.socketId !== socket.id);
      io.to(`queue_${tier}`).emit('queue_update', {
        playersCount: queues[tier].length,
        targetPlayers: 3
      });
    });

    // Remove from private rooms
    Object.keys(privateRooms).forEach(roomId => {
      const room = privateRooms[roomId];
      room.players = room.players.filter(p => p.socketId !== socket.id);
      if (room.players.length === 0) {
        delete privateRooms[roomId];
      } else {
        // If host disconnected, assign new host or delete
        if (room.hostUserId === authenticatedUser.userId) {
          const nextPlayer = room.players[0];
          if (nextPlayer) {
            room.hostUserId = nextPlayer.userId;
            room.hostSocketId = nextPlayer.socketId;
          }
        }
        io.to(`room_${roomId}`).emit('private_update', {
          players: room.players.map(p => ({ userId: p.userId, name: p.name })),
          entryFee: room.entryFee
        });
      }
    });
  });
});

// End Match Handler
async function endMatch(matchId) {
  const match = activeMatches[matchId];
  if (!match) return null;

  try {
    // Save any unfinished player results as 0 score, 60s
    for (const p of match.players) {
      if (!p.finished) {
        p.finished = true;
        p.timeTaken = 60;
        await db.updatePlayerResult(matchId, p.userId, p.score, p.timeTaken);
      }
      delete userToMatchMap[p.userId]; // Clear mapping cache
    }

    await db.updateMatchStatus(matchId, 'finished');

    // Build leaderboard sorted by score (desc), then timeTaken (asc)
    const board = match.players.map(p => ({
      id: p.userId,
      name: p.name,
      score: p.score,
      timeTaken: p.timeTaken
    })).sort((a, b) => b.score - a.score || a.timeTaken - b.timeTaken);

    // Compute payout math: Total Pot - 20% System Fee
    const totalPot = match.players.length * match.entryFee;
    const platformFee = totalPot * 0.20;
    const winnings = totalPot - platformFee;

    // Determine Winner(s) - handle ties for top score and time taken
    const topScore = board[0].score;
    const topTime = board[0].timeTaken;
    const winners = board.filter(p => p.score === topScore && p.timeTaken === topTime);
    const splitWinnings = winnings / winners.length;
    const winnerIds = winners.map(w => w.id);
    const winnerId = winnerIds[0] || null;
    
    // Credit winnings to winner(s)
    for (const w of winners) {
      await db.updateUserBalance(w.id, splitWinnings);
      await db.createTransaction(generateId().toUpperCase(), w.id, 'payout', splitWinnings, 'completed', null);
    }

    // Emit GameOver to all sockets if they are connected via ws
    match.players.forEach(p => {
      if (p.socketId) {
        io.to(p.socketId).emit('game_over', {
          leaderboard: board,
          winnerId,
          winnerIds,
          winnings: splitWinnings,
          totalPot,
          platformFee
        });
      }
    });

    console.log(`Match ${matchId} ended. Winner: ${board[0].name} (Score: ${board[0].score}/5, Payout: KSh ${winnings})`);
    
    return {
      leaderboard: board,
      winnerId,
      winnings: splitWinnings,
      totalPot,
      platformFee
    };
  } catch (err) {
    console.error(err);
    return null;
  } finally {
    delete activeMatches[matchId];
  }
}

// Start Server Wrapper
async function startServer() {
  try {
    // Initialize Database (and seed if empty)
    await db.initDb();
    
    // Load questions cache
    await loadQuestionsCache();

    // Load queues from database
    await loadQueuesFromDb();
    
    const PORT = process.env.PORT || 5000;
    server.listen(PORT, () => {
      console.log(`ChapaQuiz Backend Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Critical failure starting server:', err);
    process.exit(1);
  }
}

startServer();
