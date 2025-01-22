# Star Citizen Patch Notes Discord Bot

A Discord bot that automatically fetches and posts the latest Star Citizen patch notes from the official Spectrum forum. It can also be manually triggered using the `/patchnotes` command. The bot supports multiple servers, with each server storing its own configuration for channels, roles, and OpenAI API keys. The bot uses Puppeteer for web scraping and ChatGPT (via OpenAI API) to format the patch notes for better readability.

## Features

- **Multi-Server Support**: Each server can configure its own settings, including channel, role, and OpenAI API key.
- **Automatic Updates**: Fetches and posts new patch notes as soon as they are published.
- **Manual Trigger**: Use the `/patchnotes` command to fetch and post the latest patch notes at any time.
- **ChatGPT Integration**: Formats patch notes for clarity and readability.
- **Role Mention**: Pings a specific role (e.g., `@Patch Updates`) when new patch notes are posted.
- **Persistent Configuration**: Server configurations persist across bot restarts.

# Simple Install
Just use the app! https://discord.com/discovery/applications/1329307874169585725 

# Custom Install

## Prerequisites

Before running the bot, ensure you have the following:

- **Node.js** (v16 or higher) installed on your system.
- **A Discord Bot Token** from the [Discord Developer Portal](https://discord.com/developers/applications).
- **An OpenAI API Key** from [OpenAI](https://platform.openai.com/signup/).
- **A Discord Server** where the bot will be deployed.

## Setup

### 1. Clone the Repository

```bash
git clone https://github.com/your-username/star-citizen-patch-notes-bot.git
cd star-citizen-patch-notes-bot
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Create a `.env` File

Create a `.env` file in the root directory of the project and add the following variables:

```env
TOKEN=your_discord_bot_token
CLIENT_ID=your_discord_bot_client_id
```

Replace the placeholders with your actual credentials.

### 4. Invite the Bot to Your Server

Use the following URL to invite the bot to your Discord server. Replace `YOUR_CLIENT_ID` with your bot's client ID:

```plaintext
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=2147485696&scope=bot%20applications.commands
```

### 5. Run the Bot

```bash
npm start
```

The bot will start monitoring the Star Citizen Spectrum forum for new patch notes. Configuration for each server must be done using the `/setup` command.

## Usage

### Setup (`/setup`)

Use the `/setup` command to configure the bot for your server. You'll need to provide:

1. The channel where patch notes should be posted.
2. Your OpenAI API key.
3. (Optional) The role to mention when new patch notes are posted.

Example command:

```plaintext
/setup channel:#patch-notes openai_key:sk-abcdef123456 pingrole:@PatchUpdates
```

### Automatic Updates

The bot checks for new patch notes every 60 seconds. If a new thread is detected, it will:

1. Fetch the patch notes.
2. Format them using ChatGPT.
3. Post them in the specified Discord channel.
4. Mention the configured role (if applicable).

### Manual Trigger (`/patchnotes`)

Use the `/patchnotes` command in your Discord server to manually fetch and post the latest patch notes.

### Reset Configuration (`/reset`)

Use the `/reset` command to clear the bot's configuration for your server. After running this command, you'll need to reconfigure the bot using `/setup`.

## Configuration

### Persistent Configuration

Server-specific settings, such as channels, roles, and OpenAI API keys, are stored in a `config.json` file. This ensures configurations persist across bot restarts.

### Environment Variables

| Variable   | Description                           |
|------------|---------------------------------------|
| `TOKEN`    | Your Discord bot token.              |
| `CLIENT_ID`| Your Discord bot client ID.          |

## Technologies Used

- **[Discord.js](https://discord.js.org/)**: Interacting with the Discord API.
- **[Puppeteer](https://pptr.dev/)**: Web scraping to fetch patch notes from the Spectrum forum.
- **[Cheerio](https://cheerio.js.org/)**: Parsing and extracting data from HTML.
- **[OpenAI API](https://openai.com/)**: Formatting patch notes using ChatGPT.

## Contributing

Contributions are welcome! If you'd like to improve the bot, follow these steps:

1. Fork the repository.
2. Create a new branch for your feature or bugfix.
3. Submit a pull request.

## License

This project is licensed under the MIT License. See the `LICENSE` file for details.

## Support

If you encounter any issues or have questions, feel free to open an issue on GitHub or contact me directly.

Enjoy your Star Citizen Patch Notes Discord Bot! 🚀

