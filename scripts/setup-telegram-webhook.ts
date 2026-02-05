/**
 * Setup Telegram Webhook
 * 
 * Usage:
 *   npx tsx scripts/setup-telegram-webhook.ts <webhook-url>
 *   npx tsx scripts/setup-telegram-webhook.ts menu     # Set bot commands menu
 *   npx tsx scripts/setup-telegram-webhook.ts info     # Show current webhook info
 *   npx tsx scripts/setup-telegram-webhook.ts delete   # Delete webhook
 * 
 * Example:
 *   npx tsx scripts/setup-telegram-webhook.ts https://your-domain.com/api/telegram/webhook
 */

import * as dotenv from 'dotenv';
dotenv.config();

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';

// Bot commands for the menu
const BOT_COMMANDS = [
    { command: 'chats', description: '📋 Browse and select chats' },
    { command: 'back', description: '🤖 Return to main agent' },
    { command: 'status', description: '📊 Show system status' },
    { command: 'clear', description: '🗑️ Clear conversation history' },
    { command: 'start', description: '🚀 Start the bot' },
    { command: 'help', description: '📚 Show help' }
];

async function setCommands(token: string) {
    console.log('📋 Setting bot commands menu...');
    const response = await fetch(`${TELEGRAM_API_BASE}${token}/setMyCommands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            commands: BOT_COMMANDS,
        }),
    });
    const result = await response.json();
    console.log(JSON.stringify(result, null, 2));
    
    if (result.ok) {
        console.log('\n✅ Bot commands menu set successfully!');
        console.log('\nCommands:');
        BOT_COMMANDS.forEach(cmd => {
            console.log(`  /${cmd.command} - ${cmd.description}`);
        });
    } else {
        console.log('\n❌ Failed to set commands');
    }
}

async function main() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
        console.error('❌ TELEGRAM_BOT_TOKEN not set in .env file');
        process.exit(1);
    }

    const arg1 = process.argv[2];

    console.log('🤖 Telegram Bot Setup\n');

    // Handle different actions
    if (arg1 === 'menu' || arg1 === 'commands') {
        await setCommands(token);
        return;
    }

    if (arg1 === 'delete' || arg1 === 'remove') {
        // Delete webhook
        console.log('🗑️ Deleting webhook...');
        const deleteResponse = await fetch(`${TELEGRAM_API_BASE}${token}/deleteWebhook`);
        const deleteResult = await deleteResponse.json();
        console.log(JSON.stringify(deleteResult, null, 2));
        return;
    }

    if (arg1 === 'info' || !arg1) {
        // Get current webhook info
        console.log('📡 Current webhook info:');
        const infoResponse = await fetch(`${TELEGRAM_API_BASE}${token}/getWebhookInfo`);
        const info = await infoResponse.json();
        console.log(JSON.stringify(info, null, 2));
        console.log();
        
        // Get current commands
        console.log('📋 Current bot commands:');
        const cmdResponse = await fetch(`${TELEGRAM_API_BASE}${token}/getMyCommands`);
        const cmdResult = await cmdResponse.json();
        console.log(JSON.stringify(cmdResult, null, 2));
        
        if (!arg1) {
            console.log('\nUsage:');
            console.log('  Set webhook:    npx tsx scripts/setup-telegram-webhook.ts <webhook-url>');
            console.log('  Set menu:       npx tsx scripts/setup-telegram-webhook.ts menu');
            console.log('  Delete webhook: npx tsx scripts/setup-telegram-webhook.ts delete');
            console.log('  Show info:      npx tsx scripts/setup-telegram-webhook.ts info');
            console.log();
            console.log('Example:');
            console.log('  npx tsx scripts/setup-telegram-webhook.ts https://your-domain.ngrok.io/api/telegram/webhook');
        }
        return;
    }

    // Set webhook
    const webhookUrl = arg1;
    console.log(`🔗 Setting webhook to: ${webhookUrl}`);
    const setResponse = await fetch(`${TELEGRAM_API_BASE}${token}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            url: webhookUrl,
            allowed_updates: ['message', 'callback_query'],
        }),
    });
    const setResult = await setResponse.json();
    console.log(JSON.stringify(setResult, null, 2));

    if (setResult.ok) {
        console.log('\n✅ Webhook set successfully!');
        
        // Also set commands
        await setCommands(token);
        
        console.log(`\n📱 Now send a message to your bot to test it.`);
    } else {
        console.log('\n❌ Failed to set webhook');
    }
}

main().catch(console.error);
