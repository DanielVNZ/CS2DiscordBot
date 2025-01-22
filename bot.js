// Load environment variables from local.env file
require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fs = require('fs');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');

// Discord bot setup
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// OpenAI setup - use key from .env
const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Persistent configuration file
const CONFIG_FILE = '/app/data/config2.json'; // production DONT DELETE
//const CONFIG_FILE = 'config.json'; // Testing
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

// Forum URL to monitor
const FORUM_URL = 'https://robertsspaceindustries.com/spectrum/community/SC/forum/190048';

// Global state for forum monitoring
let latestThreadUrl = null;
let lastPatchNotesData = null; // Cache the latest patch notes

// Function to fetch the latest thread URL
async function getLatestThreadUrl() {
    let browser;

    try {
        console.log('Launching browser to check for updates...');
        browser = await puppeteer.launch({
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();

        console.log('Navigating to the forum page...');
        await page.goto(FORUM_URL, { waitUntil: 'networkidle2', timeout: 60000 });

        console.log('Extracting latest thread link...');
        const latestPostLink = await page.$eval('a.thread-subject', (el) => el.getAttribute('href'));
        if (!latestPostLink) {
            console.error('No latest thread found.');
            return null;
        }

        const latestPostURL = `https://robertsspaceindustries.com${latestPostLink}`;
        console.log(`Latest thread URL: ${latestPostURL}`);

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

// Function to process patch notes with ChatGPT
async function processPatchNotesWithChatGPT(content) {
    try {
        const prompt = `You are a helpful assistant that formats patch notes for Star Citizen. Don't include a release date/time! Besides this, YOU MUST INCLUDE EVERYTHING FROM THE TITLE AT THE TOP TO THE END OF THE TECHNICAL CATEGORY! Make sure to show any special requests or any testing/feedback focus. Include all Known issues, Features & Gameplay, Bug Fixes, and Technical. Use markdown for formatting:\n\n${content}`;

        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: 'You are a helpful assistant that formats patch notes for Star Citizen.' },
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

// Function to fetch and format patch notes
async function getLatestPatchNotesContent(url, sourceId = null, isDM = false) {
    let browser;

    try {
        console.log('Launching browser to fetch patch notes...');
        browser = await puppeteer.launch({
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();

        console.log('Navigating to the latest patch notes page...');
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

        console.log('Waiting for the content to load...');
        await page.waitForSelector('div.content-main', { timeout: 60000 });

        console.log('Extracting patch notes content...');
        const html = await page.content();
        const $ = cheerio.load(html);

        const contentMain = $('div.content-main');
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

// Function to check for updates and post patch notes
async function checkForUpdates() {
    console.log('Checking for updates...');
    if (Object.keys(serverConfigs).length === 0) {
        console.log('No servers configured. Skipping update check.');
        return;
    }

    try {
        const latestUrl = await getLatestThreadUrl();

        if (latestUrl && latestUrl !== latestThreadUrl) {
            console.log('New thread detected! Fetching patch notes...');
            latestThreadUrl = latestUrl;

            const patchNotesData = await getLatestPatchNotesContent(latestUrl, null, false);
            if (patchNotesData && patchNotesData.content) {
                lastPatchNotesData = patchNotesData; // Cache the patch notes
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
                await channel.send(`${roleMention} **New Patch Has Just Dropped!**\n${url}`);

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

                await user.send(`**New Star Citizen Patch Notes!**\n${url}`);

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
                        
                        await interaction.editReply(`**Latest Star Citizen Patch Notes:**\n${url}`);

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
                    await channel.send(`${roleMention} **Latest Star Citizen Patch Notes:**\n${url}`);

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
        description: 'Fetch the latest Star Citizen patch notes',
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

// Start polling for updates
client.once('ready', async () => {
    console.log('Bot is ready!');
    loadConfig();
    
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
