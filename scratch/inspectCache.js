const dotenv = require('dotenv');
dotenv.config();

const { documentCache } = require('../utils/documentCache.js');

async function inspect() {
  const hash = 'baa6ac0dc7b8b35ba8d30eda3cae260d0bfebe54e72cc3354f7fec18c6223e7b';
  const key = `mindmap:document:${hash}`;
  try {
    const value = await documentCache.get(key);
    console.log('--- Cached Payload ---');
    console.log(JSON.stringify(value, null, 2));
  } catch (error) {
    console.error('Error inspecting cache:', error);
  }
}

inspect().then(() => process.exit(0));
