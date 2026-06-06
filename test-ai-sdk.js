// test-ai-sdk.js
const { z } = require('zod');

(async () => {
  try {
    const { streamObject } = await import('ai');
    const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
    const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY || 'fake-key' });
    
    console.log('Successfully imported AI SDK and Google provider.');
    
    // We try to call streamObject with a mock call to trigger validation
    try {
      streamObject({
        model: google('gemini-2.5-flash'),
        schema: z.object({ mainTopic: z.string() }),
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Hello' },
            {
              type: 'file',
              data: Buffer.from('mock data'),
              mediaType: 'text/plain', // Let's see if this throws validation error
              filename: 'test.txt'
            }
          ]
        }]
      });
      console.log('No immediate validation error for mediaType.');
    } catch (e) {
      console.error('Validation error with mediaType:', e.message);
    }
  } catch (err) {
    console.error('Import Error:', err);
  }
})();
