// Load environment variables from local.env file
require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fs = require('fs');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');

// Discord bot setup
const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageTyping,
        GatewayIntentBits.DirectMessageReactions,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildPresences  // optional
    ] 
});

// OpenAI setup - use key from .env
const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Persistent configuration file
const CONFIG_FILE = '/app/data/configcs2.json'; // production DONT DELET
//const CONFIG_FILE = 'configcs2.json'; // Testing
let serverConfigs = {};
let dmUserConfigs = {};

// Load configuration from file
function loadConfig() {
    if (fs.existsSync(CONFIG_FILE)) {
        const data = JSON.parse(fs.readFileSync(CONFIG_FILE));
        serverConfigs = data.servers || {};
        dmUserConfigs = data.dmUsers || {};
        console.log('Loaded server configurations:', serverConfigs);
        console.log('Loaded DM user configurations:', dmUserConfigs);
        console.log('Configuration loaded.');
    } else {
        console.log('No configuration found. Please run /setup to configure the bot.');
    }
}

// Save configuration to file
function saveConfig() {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({
        servers: serverConfigs,
        dmUsers: dmUserConfigs
    }, null, 4));
    console.log('Configuration saved.');
}

// Reset configuration for a specific server
function resetServerConfig(guildId) {
    if (serverConfigs[guildId]) {
        delete serverConfigs[guildId];
        saveConfig();
    }
    console.log(`Configuration reset for server ${guildId}.`);
}

// Update forum URL to monitor
const FORUM_URL = 'https://forum.paradoxplaza.com/forum/members/cities-skylines-official.1750459/#recent-content';
const LOGIN_URL = 'https://forum.paradoxplaza.com/forum/login';

// Global state for forum monitoring
let latestThreadUrl = null;
let lastPatchNotesData = null; // Cache the latest patch notes

// Add this helper function at the top of your file
async function retry(fn, retries = 3, delay = 2000) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (i === retries - 1) throw error;
            console.log(`Attempt ${i + 1} failed, retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

// Function to handle login
async function loginToForum(page) {
    try {
        console.log('Navigating to initial page...');
        await page.goto(FORUM_URL, { waitUntil: 'networkidle0' });

        // Click the initial login button that appears when not authenticated
        console.log('Clicking initial login button...');
        await page.waitForSelector('a.button.button--icon.button--icon--login.rippleButton', {
            timeout: 30000
        });
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle0' }),
            page.click('a.button.button--icon.button--icon--login.rippleButton')
        ]);

        // Wait for login form and enter credentials
        console.log('On login page, entering credentials...');
        await page.waitForSelector('input#email--js', { timeout: 30000 });
        await page.waitForSelector('input#password--js', { timeout: 30000 });

        // Type credentials with delay to simulate human input
        await page.type('input#email--js', process.env.FORUM_EMAIL, { delay: 100 });
        await page.type('input#password--js', process.env.FORUM_PASSWORD, { delay: 100 });
        
        // Click the login submit button and wait for navigation
        console.log('Clicking submit button...');
        await page.waitForSelector('input#submit--js', { timeout: 30000 });
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle0' }),
            page.click('input#submit--js')
        ]);

        // Verify we're logged in
        console.log('Verifying login success...');
        const isLoggedIn = await page.evaluate(() => {
            return !document.querySelector('a.button.button--icon.button--icon--login.rippleButton');
        });

        if (!isLoggedIn) {
            throw new Error('Login verification failed');
        }

        console.log('Login successful');
        return true;
    } catch (error) {
        console.error('Login failed:', error);
        return false;
    }
}

// Update the getLatestThreadUrl function
async function getLatestThreadUrl() {
    let browser;

    try {
        console.log('Launching browser to check for updates...');
        browser = await puppeteer.launch({
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            headless: "new"  // Change to headless mode
        });
        const page = await browser.newPage();

        await page.setViewport({ width: 1280, height: 800 });

        // Login first
        const loginSuccess = await loginToForum(page);
        if (!loginSuccess) {
            throw new Error('Failed to login to forum');
        }

        console.log('Navigating to the forum page...');
        await page.goto(FORUM_URL, { 
            waitUntil: ['networkidle0', 'domcontentloaded'],
            timeout: 60000 
        });

        // Add a longer wait to ensure content loads
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Wait for the content to load and extract the first thread
        console.log('Waiting for content to load...');
        await page.waitForSelector('.contentRow-title a[href*="/threads/"]', {
            timeout: 30000
        });

        // Extract the first post link
        console.log('Extracting latest post link...');
        const latestPostLink = await page.evaluate(() => {
            const firstPost = document.querySelector('.contentRow-title a[href*="/threads/"]');
            if (!firstPost) return null;
            
            console.log('Found thread:', firstPost.textContent);
            return firstPost.getAttribute('href');
        });

        if (!latestPostLink) {
            console.error('No latest thread found.');
            return null;
        }

        const latestPostURL = `https://forum.paradoxplaza.com${latestPostLink}`;
        console.log(`Latest thread URL: ${latestPostURL}`);

        // Add a small delay before closing
        await new Promise(resolve => setTimeout(resolve, 2000));

        return latestPostURL;
    } catch (error) {
        console.error('Error fetching latest thread URL:', error);
        return null;
    } finally {
        if (browser) {
            console.log('Closing browser...');
            await browser.close();
        }
    }
}

// Update ChatGPT prompt for Cities Skylines 2
async function processPatchNotesWithChatGPT(content) {
    try {
        const prompt = `You are a helpful assistant that formats patch notes for Cities Skylines 2. Format the patch notes in a clear, readable way using markdown formatting. Include the title, any important notices, and organize the content into relevant sections like Features, Bug Fixes, and Technical Updates:\n\n${content}`;

        const response = await openai.chat.completions.create({
            model: 'gpt-4-turbo-preview',
            messages: [
                { role: 'system', content: 'You are a helpful assistant that formats patch notes for Cities Skylines 2.' },
                { role: 'user', content: prompt },
            ],
            max_tokens: 3500,
        });

        return response.choices[0].message.content.trim();
    } catch (error) {
        console.error('Error processing patch notes with ChatGPT:', error);
        return null;
    }
}

// Update getLatestPatchNotesContent to handle public threads
async function getLatestPatchNotesContent(url) {
    let browser;

    try {
        console.log('Launching browser to fetch patch notes...');
        browser = await puppeteer.launch({
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            headless: "new"  // Change to headless mode
        });
        const page = await browser.newPage();

        console.log('Navigating to the latest patch notes page...');
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

        // Wait for the content to load
        console.log('Waiting for the content to load...');
        await page.waitForSelector('article.message-body', { timeout: 60000 });

        // Add a small delay to ensure everything loads
        await new Promise(resolve => setTimeout(resolve, 2000));

        console.log('Extracting patch notes content...');
        const html = await page.content();
        const $ = cheerio.load(html);

        // Get the content from the first post
        const contentMain = $('article.message-body').first();
        if (!contentMain.length) {
            console.error('No content found in the main container.');
            return null;
        }

        const rawContent = contentMain.text().trim();
        if (!rawContent) {
            console.error('No content extracted from the patch notes page.');
            return null;
        }

        const formattedContent = await processPatchNotesWithChatGPT(rawContent);
        if (!formattedContent) {
            console.error('ChatGPT failed to process the patch notes.');
            return null;
        }

        return { url, content: formattedContent };
    } catch (error) {
        console.error('Error fetching patch notes content:', error);
        return null;
    } finally {
        if (browser) {
            console.log('Closing browser...');
            await browser.close();
        }
    }
}

// Then modify the checkForUpdates function to use retry
async function checkForUpdates() {
    console.log('Checking for updates...');
    if (Object.keys(serverConfigs).length === 0) {
        console.log('No servers configured. Skipping update check.');
        return;
    }

    try {
        const latestUrl = await retry(() => getLatestThreadUrl());
        
        if (latestUrl && latestUrl !== latestThreadUrl) {
            console.log('New thread detected! Fetching patch notes...');
            latestThreadUrl = latestUrl;

            const patchNotesData = await retry(() => getLatestPatchNotesContent(latestUrl));
            if (patchNotesData && patchNotesData.content) {
                lastPatchNotesData = patchNotesData;
                await distributeUpdatesToServers(patchNotesData);
            }
        }
    } catch (error) {
        console.error('Error in checkForUpdates:', error);
    }
}

// New function to handle distributing updates to all configured servers
async function distributeUpdatesToServers(patchNotesData) {
    const { url, content } = patchNotesData;
    const parts = content.match(/.{1,2000}/gs) || [];

    // First handle server distributions
    const batchSize = 10;
    const serverEntries = Object.entries(serverConfigs);
    
    for (let i = 0; i < serverEntries.length; i += batchSize) {
        const batch = serverEntries.slice(i, i + batchSize);
        
        await Promise.allSettled(batch.map(async ([guildId, config]) => {
            try {
                const channel = await client.channels.fetch(config.channelId);
                if (!channel) {
                    console.log(`Channel not found for server ${guildId}. Skipping.`);
                    return;
                }

                const roleMention = config.pingRoleId ? `<@&${config.pingRoleId}>` : '';
                await channel.send(`${roleMention} **New Cities Skylines 2 Patch Notes Available!**\n${url}`);

                for (const [index, part] of parts.entries()) {
                    await channel.send({
                        content: part,
                        flags: index > 0 ? MessageFlags.SuppressNotifications : 0
                    });
                    await new Promise(resolve => setTimeout(resolve, 500));
                }

                console.log(`Successfully posted update to server ${guildId}`);
            } catch (error) {
                console.error(`Failed to post update to server ${guildId}:`, error);
            }
        }));

        await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // Then handle DM distributions
    const dmUserEntries = Object.entries(dmUserConfigs);
    for (let i = 0; i < dmUserEntries.length; i += batchSize) {
        const batch = dmUserEntries.slice(i, i + batchSize);
        
        await Promise.allSettled(batch.map(async ([userId, config]) => {
            try {
                const user = await client.users.fetch(userId);
                if (!user) {
                    console.log(`User ${userId} not found. Skipping.`);
                    return;
                }

                await user.send(`**New Cities Skylines 2 Patch Notes!**\n${url}`);

                for (const part of parts) {
                    await user.send(part);
                    await new Promise(resolve => setTimeout(resolve, 500));
                }

                console.log(`Successfully sent update to user ${userId}`);
            } catch (error) {
                console.error(`Failed to send update to user ${userId}:`, error);
            }
        }));

        await new Promise(resolve => setTimeout(resolve, 2000));
    }
}

// Modify the permission check function to handle DMs
async function checkAdminPermission(interaction) {
    // Allow DM interactions
    if (!interaction.guild) {
        return true;
    }

    // Check server permissions
    if (!interaction.member?.permissions.has('Administrator')) {
        await interaction.reply({
            content: 'This command is only available to server administrators.',
            ephemeral: true
        });
        return false;
    }
    return true;
}

// Then modify the command handling to properly await the check
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand() && !interaction.isButton()) return;

    if (interaction.isCommand()) {
        // Check admin permissions for all commands
        const hasPermission = await checkAdminPermission(interaction);
        if (!hasPermission) return;

        if (interaction.commandName === 'setup') {
            try {
                await interaction.deferReply({ ephemeral: true });

                // Different handling for DMs vs Server setup
                if (!interaction.guild) {
                    // Save DM user configuration
                    dmUserConfigs[interaction.user.id] = {
                        enabled: true // Just track that they're enabled for DMs
                    };
                    
                    saveConfig();
                    
                    await interaction.editReply('Setup complete! You will now receive patch notes automatically in DMs when they are released.');
                    return;
                }

                // Server setup code
                const channel = interaction.options.getChannel('channel');
                const pingRole = interaction.options.getRole('pingrole');

                // Save server-specific configuration
                serverConfigs[interaction.guildId] = {
                    channelId: channel.id,
                    pingRoleId: pingRole ? pingRole.id : null
                };
                
                saveConfig();

                await interaction.editReply({
                    content: `Patch notes will now be posted in <#${channel.id}>${
                        pingRole ? ` and will ping <@&${pingRole.id}>` : ''
                    }.`
                });

                console.log(`Setup complete for server ${interaction.guildId}`);
            } catch (error) {
                console.error('Error handling /setup command:', error.message);
                await interaction.editReply('An error occurred while processing your request.');
            }
        } else if (interaction.commandName === 'patchnotes') {
            try {
                await interaction.deferReply();

                // If in DMs, check if user is configured first
                if (!interaction.guild) {
                    const userConfig = dmUserConfigs[interaction.user.id];
                    if (!userConfig) {
                        await interaction.editReply({
                            content: 'You have not set up the bot for DMs. Please run `/setup` first to receive patch notes.',
                            ephemeral: true
                        });
                        return;
                    }

                    // Use cached patch notes only
                    if (lastPatchNotesData) {
                        const { url, content } = lastPatchNotesData;
                        
                        await interaction.editReply(`**Latest Cities Skylines 2 Patch Notes:**\n${url}`);

                        const parts = content.match(/.{1,2000}/gs) || [];
                        for (const part of parts) {
                            await interaction.followUp({
                                content: part,
                                ephemeral: true
                            });
                            await new Promise(resolve => setTimeout(resolve, 500));
                        }
                    } else {
                        await interaction.editReply('No patch notes are currently cached. Please try again in a moment.');
                    }
                    return;
                }

                // If in a server, check for server config
                const serverConfig = serverConfigs[interaction.guildId];
                if (!serverConfig) {
                    await interaction.editReply({
                        content: 'This server is not configured. Please ask a server administrator to run `/setup` first.',
                        ephemeral: true
                    });
                    return;
                }

                // Use cached patch notes only
                if (lastPatchNotesData) {
                    const { url, content } = lastPatchNotesData;
                    const channel = await client.channels.fetch(serverConfig.channelId);
                    
                    if (!channel) {
                        await interaction.editReply('Error: Could not find the configured channel.');
                        return;
                    }

                    const roleMention = serverConfig.pingRoleId ? `<@&${serverConfig.pingRoleId}>` : '';
                    await channel.send(`${roleMention} **Latest Cities Skylines 2 Patch Notes:**\n${url}`);

                    const parts = content.match(/.{1,2000}/gs) || [];
                    for (const part of parts) {
                        await channel.send(part);
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }

                    await interaction.editReply('Patch notes have been posted.');
                } else {
                    await interaction.editReply('No patch notes are currently cached. Please try again in a moment.');
                }
            } catch (error) {
                console.error('Error handling /patchnotes command:', error);
                await interaction.editReply('An error occurred while processing your request.');
            }
        } else if (interaction.commandName === 'reset') {
            try {
                await interaction.deferReply({ ephemeral: true });

                // Reset server-specific configuration
                resetServerConfig(interaction.guildId);

                await interaction.editReply('Setup has been deleted. You will need to run `/setup` to use the bot again.');
                console.log(`Setup reset for server ${interaction.guildId}`);
            } catch (error) {
                console.error('Error handling /reset command:', error.message);
                try {
                    await interaction.editReply('An error occurred while processing your request.');
                } catch (replyError) {
                    console.error('Failed to edit reply:', replyError.message);
                }
            }
        } else if (interaction.commandName === 'help') {
            try {
                const row = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('setup')
                            .setLabel('Setup')
                            .setStyle(ButtonStyle.Primary),
                        new ButtonBuilder()
                            .setCustomId('patchnotes')
                            .setLabel('Patch Notes')
                            .setStyle(ButtonStyle.Primary),
                        new ButtonBuilder()
                            .setCustomId('check')
                            .setLabel('Check Status')
                            .setStyle(ButtonStyle.Primary),
                        new ButtonBuilder()
                            .setCustomId('reset')
                            .setLabel('Reset')
                            .setStyle(ButtonStyle.Danger)
                    );

                await interaction.reply({
                    content: ``,
                    components: [row],
                    ephemeral: true
                });
            } catch (error) {
                console.error('Error handling /help command:', error.message);
                try {
                    await interaction.reply('An error occurred while processing your request.');
                } catch (replyError) {
                    console.error('Failed to reply:', replyError.message);
                }
            }
        } else if (interaction.commandName === 'check') {
            try {
                const serverConfig = serverConfigs[interaction.guildId];
                if (!serverConfig) {
                    await interaction.reply({
                        content: 'This server is not configured. Please run `/setup` first.',
                        ephemeral: true
                    });
                    return;
                }

                const channel = await client.channels.fetch(serverConfig.channelId).catch(() => null);
                const channelName = channel ? `#${channel.name}` : null;
                const pingRole = serverConfig.pingRoleId ? `<@&${serverConfig.pingRoleId}>` : 'None';

                let connectionStatus = 'Server Not Connected, run `/setup`';
                if (channelName) {
                    connectionStatus = 'Server Connected';
                }

                await interaction.reply({
                    content: `
                    **Server Configuration:**
                    • **Channel:** ${channelName || 'Unknown'}
                    • **Ping Role:** ${pingRole}
                    • **Status:** ${connectionStatus}
                    `,
                    ephemeral: true
                });
            } catch (error) {
                console.error('Error handling /check command:', error.message);
                await interaction.reply('An error occurred while processing your request.');
            }
        } else if (interaction.commandName === 'test') {
            try {
                await interaction.deferReply({ ephemeral: true });

                // Get the latest thread URL and patch notes
                const testUrl = await getLatestThreadUrl();
                if (!testUrl) {
                    await interaction.editReply('Could not fetch the latest forum thread. Test failed.');
                    return;
                }

                const patchNotesData = await getLatestPatchNotesContent(testUrl);
                if (!patchNotesData || !patchNotesData.content) {
                    await interaction.editReply('Could not fetch patch notes content. Test failed.');
                    return;
                }

                // Store the data in cache
                lastPatchNotesData = patchNotesData;
                
                // Distribute to all servers
                await distributeUpdatesToServers(patchNotesData);
                await interaction.editReply('Test successful: Latest patch notes have been distributed to all configured servers.');
                
                // Log the test event
                console.log(`Test distribution initiated by admin in server ${interaction.guildId}`);
            } catch (error) {
                console.error('Error handling /test command:', error);
                await interaction.editReply('An error occurred while testing the distribution system.');
            }
        } else if (interaction.commandName === 'forceupdate') {
            try {
                await interaction.deferReply({ ephemeral: true });

                const oldUrl = latestThreadUrl;
                latestThreadUrl = await getLatestThreadUrl();
                
                if (!latestThreadUrl) {
                    await interaction.editReply('Failed to fetch the forum page. Please try again later.');
                    return;
                }

                if (latestThreadUrl === oldUrl) {
                    await interaction.editReply('No new patch notes found. Cache is up to date.');
                    return;
                }

                const patchNotesData = await getLatestPatchNotesContent(latestThreadUrl);
                if (!patchNotesData || !patchNotesData.content) {
                    await interaction.editReply('Failed to fetch patch notes content.');
                    return;
                }

                // Update cache
                lastPatchNotesData = patchNotesData;
                await interaction.editReply('Successfully updated patch notes cache. Use `/patchnotes` to view the latest notes.');
                
                console.log(`Force update initiated by admin in ${interaction.guild ? `server ${interaction.guildId}` : 'DMs'}`);
            } catch (error) {
                console.error('Error handling /forceupdate command:', error);
                await interaction.editReply('An error occurred while forcing the update.');
            }
        }
    } else if (interaction.isButton()) {
        // Check admin permissions for buttons
        const hasPermission = await checkAdminPermission(interaction);
        if (!hasPermission) return;

        if (interaction.customId === 'setup') {
            await interaction.reply('Please use the `/setup` command to set up the bot. Requires OpenAI API Key - https://platform.openai.com/account/api-keys', { ephemeral: true });
        } else if (interaction.customId === 'patchnotes') {
            await interaction.reply('Please use the `/patchnotes` command to fetch the latest patch notes. /setup must be run once first');
        } else if (interaction.customId === 'reset') {
            await interaction.reply('Please use the `/reset` command to reset the bot setup.');
        } else if (interaction.customId === 'check') {
            await interaction.reply('Please use the `/check` command to check the bot setup status.');
        }
    }
});

// Login to Discord
client.login(process.env.TOKEN);

// Slash command registration
const commands = [
    {
        name: 'patchnotes',
        description: 'Fetch the latest Cities Skylines 2 patch notes',
    },
    {
        name: 'setup',
        description: 'Set up the bot to post patch notes',
        options: [
            {
                name: 'channel',
                type: 7, // Channel type
                description: 'The channel where the bot should post patch notes',
                required: true,
            },
            {
                name: 'pingrole',
                type: 8, // Role type
                description: 'The role to ping when new patch notes are posted (optional)',
                required: false,
            }
        ],
    },
    {
        name: 'reset',
        description: 'Reset the bot setup and delete the current configuration',
    },
    {
        name: 'help',
        description: 'Display help information about the bot commands',
    },
    {
        name: 'check',
        description: 'Check if the server is already set up and provide configuration details',
    },
    {
        name: 'test',
        description: 'Test the patch notes distribution system (Admin only)',
        options: [
            {
                name: 'message',
                type: 3, // String type
                description: 'Custom test message (optional)',
                required: false,
            }
        ],
    },
    {
        name: 'forceupdate',
        description: 'Force check for new patch notes and update cache (Admin only)',
    }
];

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

(async () => {
    try {
        console.log('Started refreshing application (/) commands.');

        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID),
            { body: commands },
        );

        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(error);
    }
})();

// Modify the ready event handler
client.once('ready', async () => {
    console.log('Bot is ready!');
    loadConfig();
    
    // Send welcome message to all DM users and servers that don't have configs yet
    try {
        // Handle servers
        client.guilds.cache.forEach(async (guild) => {
            if (!serverConfigs[guild.id]) {
                const channel = guild.channels.cache.find(
                    channel => channel.type === 0 && // 0 is text channel
                        channel.permissionsFor(guild.members.me).has('SendMessages')
                );
                
                if (channel) {
                    await channel.send("Hello! Welcome to Cities Skylines 2 Patch Notes bot! Type `/setup` to get started");
                }
            }
        });

        // Handle DM users
        client.users.cache.forEach(async (user) => {
            if (!user.bot && !dmUserConfigs[user.id]) {
                try {
                    await user.send("Hello! Welcome to Cities Skylines 2 Patch Notes bot! Type `/setup` to get started");
                } catch (error) {
                    console.error(`Failed to send welcome message to user ${user.id}:`, error);
                }
            }
        });
    } catch (error) {
        console.error('Error sending welcome messages:', error);
    }
    
    // Initial setup
    try {
        latestThreadUrl = await getLatestThreadUrl();
        if (latestThreadUrl) {
            lastPatchNotesData = await getLatestPatchNotesContent(latestThreadUrl);
        }
    } catch (error) {
        console.error('Error during initial setup:', error);
    }

    // Check for updates every 2 minutes
    setInterval(checkForUpdates, 120000);
});

// Add this new event handler for DM channel creation
client.on('channelCreate', async (channel) => {
    // Check if this is a DM channel
    if (channel.type === 1) { // 1 is DM channel type
        try {
            // Get the user from the DM channel
            const user = channel.recipient;
            if (!user || user.bot) return;

            // Check if this is a new user (not in configs)
            if (!dmUserConfigs[user.id]) {
                await channel.send("Hello! Welcome to Cities Skylines 2 Patch Notes bot! Type `/setup` to get started");
                console.log(`Sent welcome message to new DM user ${user.id}`);
            }
        } catch (error) {
            console.error('Error sending welcome message to new DM channel:', error);
        }
    }
});

// Keep existing guildCreate event for servers
client.on('guildCreate', async (guild) => {
    try {
        const channel = guild.channels.cache.find(
            channel => channel.type === 0 && 
                channel.permissionsFor(guild.members.me).has('SendMessages')
        );

        if (channel) {
            await channel.send("Hello! Welcome to Cities Skylines 2 Patch Notes bot! Type `/setup` to get started");
        }
    } catch (error) {
        console.error('Error sending welcome message to new guild:', error);
    }
});

// Add this new event handler for when users add the bot
client.on('userUpdate', async (oldUser, newUser) => {
    try {
        // Check if this is a new user interaction and they're not in configs
        if (!dmUserConfigs[newUser.id] && !newUser.bot) {
            const dmChannel = await newUser.createDM();
            await dmChannel.send("Hello! Welcome to Cities Skylines 2 Patch Notes bot! Type `/setup` to get started");
            console.log(`Sent welcome message to new user ${newUser.id}`);
        }
    } catch (error) {
        console.error('Error sending welcome message to updated user:', error);
    }
});
