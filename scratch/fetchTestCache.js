const axios = require('axios');

async function run() {
  try {
    const hash = 'baa6ac0dc7b8b35ba8d30eda3cae260d0bfebe54e72cc3354f7fec18c6223e7b';
    const response = await axios.get(`http://localhost:3000/admin/test-cache/${hash}`);
    console.log('--- Cache content from server endpoint ---');
    console.log(JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error('Error fetching test-cache:', error.message);
  }
}

run();
