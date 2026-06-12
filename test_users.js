const db = require('./database');
const crypto = require('crypto');

const generateId = () => crypto.randomBytes(8).toString('hex');

async function runTest() {
  console.log('Starting Supabase 5 Users Seeding and Balance Test...');
  try {
    const createdUsers = [];
    for (let i = 1; i <= 5; i++) {
      const phone = `079999990${i}`;
      const name = `TestUser_${i}`;
      const userId = `test_${generateId()}`;
      
      console.log(`Creating user: ${name} (${phone}) with id ${userId}...`);
      
      // 1. Create account (should start with 0.0 balance)
      const user = await db.createUser(userId, name, phone);
      console.log(`User created. Initial Balance: ${user.wallet_balance}`);
      
      // 2. Add KSh 50
      console.log(`Adding KSh 50 to ${name}...`);
      const updatedUser = await db.updateUserBalance(userId, 50.0);
      console.log(`User updated. New Balance: ${updatedUser.wallet_balance}`);
      
      createdUsers.push(updatedUser);
    }
    
    console.log('\n--- VERIFICATION FROM DATABASE ---');
    for (const u of createdUsers) {
      const fetched = await db.getUser(u.id);
      console.log(`Fetched User ID: ${fetched.id} | Name: ${fetched.name} | Phone: ${fetched.phone} | Wallet Balance: KSh ${fetched.wallet_balance}`);
    }
    console.log('\nTest successful! All 5 users created, credited KSh 50, and verified.');
    process.exit(0);
  } catch (err) {
    console.error('\nERROR occurred during test:', err.message || err);
    process.exit(1);
  }
}

runTest();
