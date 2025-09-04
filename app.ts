import { App, ExpressReceiver } from "@slack/bolt";
import axios from "axios";
import { format } from "date-fns";

// --- Configuration ---
const NOZBE_API_URL = "https://api.nozbe.com:3000";
const NOZBE_API_KEY = process.env.NOZBE_API_KEY;
const NOZBE_CLIENT_ID = process.env.NOZBE_CLIENT_ID || "434314ce3ef0e9a6d362111a282714fffb4a5759";
const NOZBE_PROJECT_ID = process.env.NOZBE_PROJECT_ID || "abc";

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const SLACK_USER_ID = process.env.SLACK_USER_ID;

const PORT = process.env.PORT || 10000;
// --- End Configuration ---

// Types
interface NozbeTask {
  id: string;
  name: string;
  completed?: boolean;
  project_id?: string;
  datetime?: string;
  next?: boolean;
  recur?: number;
  time?: number;
  comment_unread?: boolean;
  con_list?: string[];
  re_user?: string;
}

// Create Express receiver for custom routes
const receiver = new ExpressReceiver({
  signingSecret: SLACK_SIGNING_SECRET!,
  endpoints: '/slack/events',
});

// Initialize Slack Bolt app with Express receiver
const slackApp = new App({
  token: SLACK_BOT_TOKEN,
  receiver,
});

// Nozbe API functions
async function fetchNozebTasks(projectId: string): Promise<NozbeTask[]> {
  console.log(`📋 Fetching tasks from Nozbe for project: ${projectId}`);
  
  try {
    // Using API Key authentication with proper headers
    const response = await axios.get(`${NOZBE_API_URL}/tasks`, {
      params: {
        type: "project",
        id: projectId,
      },
      headers: {
        "Authorization": NOZBE_API_KEY,
        "Client": NOZBE_CLIENT_ID,
      },
    });
    
    // Debug: Log the raw response to understand its structure
    console.log("📊 Raw API Response:", JSON.stringify(response.data, null, 2));
    console.log("📊 Response type:", typeof response.data);
    console.log("📊 Is Array?", Array.isArray(response.data));
    
    // The API might return the data in a different structure
    let tasks: NozbeTask[] = [];
    
    if (Array.isArray(response.data)) {
      tasks = response.data;
    } else if (response.data && typeof response.data === 'object') {
      // It might be wrapped in an object
      console.log("📊 Response keys:", Object.keys(response.data));
      // Check for common wrapper properties
      if (response.data.tasks && Array.isArray(response.data.tasks)) {
        tasks = response.data.tasks;
      } else if (response.data.data && Array.isArray(response.data.data)) {
        tasks = response.data.data;
      } else {
        // If it's a single object, wrap it in an array
        tasks = [response.data];
      }
    }
    
    console.log(`✅ Fetched ${tasks.length} tasks from Nozbe`);
    return tasks.filter((task: NozbeTask) => !task.completed);
  } catch (error) {
    console.error("❌ Error fetching Nozbe tasks:", error);
    throw error;
  }
}

async function markTaskComplete(taskId: string): Promise<boolean> {
  console.log(`✅ Marking task ${taskId} as complete in Nozbe`);
  
  try {
    // According to Nozbe API docs, PUT request to /task with id and completed in body
    const response = await axios.put(
      `${NOZBE_API_URL}/task`,
      { 
        id: taskId,
        completed: true 
      },
      {
        headers: {
          "Content-Type": "application/json",
          "Authorization": NOZBE_API_KEY,
          "Client": NOZBE_CLIENT_ID,
        },
      }
    );
    
    console.log(`✅ Task ${taskId} marked as complete`);
    console.log("Response:", response.data);
    return true;
  } catch (error: any) {
    console.error(`❌ Error marking task ${taskId} as complete:`, error.message);
    if (error.response) {
      console.error("Response data:", error.response.data);
      console.error("Response status:", error.response.status);
    }
    return false;
  }
}

// Slack message builder (channel will be set separately)
function buildTaskMessage(tasks: NozbeTask[], channel: string) {
  const today = format(new Date(), "EEEE, MMMM d");
  
  const options = tasks.map((task) => ({
    text: {
      type: "plain_text",
      text: task.name.length > 75 ? task.name.substring(0, 72) + "..." : task.name,
    },
    value: task.id,
  }));
  
  return {
    channel: channel,
    text: `Daily Tasks - ${today}: ${tasks.length} task(s) to complete`,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `📋 Daily Tasks - ${today}`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Here are your top ${tasks.length} tasks from Nozbe. Check them off as you complete them!`,
        },
      },
      {
        type: "divider",
      },
      {
        type: "actions",
        block_id: "task_checkboxes",
        elements: [
          {
            type: "checkboxes",
            action_id: "task_complete",
            options: options,
          },
        ],
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `_Project: ${NOZBE_PROJECT_ID} • Updated: ${format(new Date(), "h:mm a")}_`,
          },
        ],
      },
    ],
  };
}

// Handle Slack interactive actions
slackApp.action("task_complete", async ({ action, ack, client, body }) => {
  // Acknowledge the action immediately
  await ack();
  
  console.log("🔔 Received Slack action");
  
  // Type guard for checkbox action
  if (action.type === "checkboxes") {
    const selectedTasks = action.selected_options || [];
    const checkedTaskIds = selectedTasks
      .map((opt) => opt.value)
      .filter((value): value is string => value !== undefined);
    
    console.log(`📝 Processing ${checkedTaskIds.length} checked tasks`);
    
    // Mark tasks as complete in Nozbe
    for (const taskId of checkedTaskIds) {
      await markTaskComplete(taskId);
    }
    
    // Update Slack message with thread reply
    if (checkedTaskIds.length > 0 && body.type === "block_actions") {
      const channelId = body.channel?.id || SLACK_USER_ID;
      if (channelId) {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: body.message?.ts,
          text: `✅ Marked ${checkedTaskIds.length} task(s) as complete in Nozbe!`,
        });
      }
    }
  }
});

// Add custom routes to Express receiver
receiver.router.get("/trigger", async (_req: any, res: any) => {
  console.log("🚀 Triggering daily task send");
  
  try {
    await sendDailyTasks();
    res.json({ success: true, message: "Daily tasks sent to Slack" });
  } catch (error) {
    console.error("❌ Error sending daily tasks:", error);
    res.status(500).json({ success: false, error: "Failed to send tasks" });
  }
});

// Health check endpoint
receiver.router.get("/health", (_req: any, res: any) => {
  res.json({ status: "healthy", timestamp: new Date().toISOString() });
});

// Helper function to get or open a DM channel with a user
async function getDMChannel(userId: string): Promise<string> {
  try {
    const result = await slackApp.client.conversations.open({
      users: userId,
    });
    
    if (result.ok && result.channel?.id) {
      console.log(`📬 Opened DM channel: ${result.channel.id}`);
      return result.channel.id;
    }
    
    throw new Error("Failed to open DM channel");
  } catch (error) {
    console.error("❌ Error opening DM channel:", error);
    throw error;
  }
}

// Main function to send daily tasks
async function sendDailyTasks() {
  console.log(`📅 Starting daily task send at ${new Date().toISOString()}`);
  
  if (!NOZBE_API_KEY) {
    throw new Error("Missing NOZBE_API_KEY. Please obtain it from the 'Settings' section in the Nozbe app");
  }
  
  if (!SLACK_BOT_TOKEN || !SLACK_USER_ID) {
    throw new Error("Missing required Slack environment variables (SLACK_BOT_TOKEN or SLACK_USER_ID)");
  }
  
  // Open DM channel with the user
  const dmChannel = await getDMChannel(SLACK_USER_ID);
  
  // Clear previous bot messages from the conversation
  try {
    console.log("🧹 Attempting to clear previous bot messages...");
    
    // Fetch conversation history
    const history = await slackApp.client.conversations.history({
      channel: dmChannel,
      limit: 100, // Fetch last 100 messages
    });
    
    if (history.messages) {
      // Filter for bot messages (sent by this app)
      const botMessages = history.messages.filter(msg => 
        msg.bot_id && msg.ts // Only messages from bots with timestamps
      );
      
      // Delete each bot message
      for (const message of botMessages) {
        if (message.ts) {
          try {
            await slackApp.client.chat.delete({
              channel: dmChannel,
              ts: message.ts,
            });
            console.log(`🗑️ Deleted message: ${message.ts}`);
          } catch (deleteError) {
            console.warn(`⚠️ Could not delete message ${message.ts}:`, deleteError);
          }
        }
      }
      
      console.log(`✅ Cleared ${botMessages.length} previous bot messages`);
    }
  } catch (error: any) {
    if (error?.data?.error === 'missing_scope') {
      console.error("❌ Missing Slack permissions to read conversation history!");
      console.error("📌 Required scopes: channels:history, groups:history, im:history, mpim:history");
      console.error("👉 Please add these scopes in your Slack app configuration at api.slack.com");
      console.error("👉 After adding scopes, reinstall the app to your workspace");
    } else {
      console.error("⚠️ Error clearing previous messages:", error);
    }
    console.log("⏭️ Continuing without clearing messages...");
  }
  
  // Fetch tasks from Nozbe
  const tasks = await fetchNozebTasks(NOZBE_PROJECT_ID);
  
  if (tasks.length === 0) {
    console.log("📭 No tasks found for today");
    await slackApp.client.chat.postMessage({
      channel: dmChannel,
      text: "🎉 No pending tasks found in Nozbe! All caught up!",
    });
    return;
  }
  
  // Get top 3 tasks (prioritize by next action field if available)
  const sortedTasks = tasks.sort((a, b) => {
    if (a.next === true) return -1;
    if (b.next === true) return 1;
    return 0;
  });
  
  const top3Tasks = sortedTasks.slice(0, 3);
  console.log(`📌 Selected top ${top3Tasks.length} tasks to send`);
  
  // Build and send Slack message
  const message = buildTaskMessage(top3Tasks, dmChannel);
  const result = await slackApp.client.chat.postMessage(message);
  
  if (result.ok) {
    console.log(`✅ Successfully sent ${top3Tasks.length} tasks to Slack`);
  } else {
    throw new Error(`Failed to send message: ${result.error}`);
  }
}

// Start Slack Bolt app
(async () => {
  await slackApp.start(PORT as number);
  console.log(`🚀 Slack Bolt app running on port ${PORT}`);
  console.log(`📋 Nozbe Project ID: ${NOZBE_PROJECT_ID}`);
  console.log(`💬 Slack User ID: ${SLACK_USER_ID}`);
  console.log(`\n🔗 Endpoints:`);
  console.log(`   - Health: http://localhost:${PORT}/health`);
  console.log(`   - Trigger: http://localhost:${PORT}/trigger`);
  console.log(`   - Slack Events: http://localhost:${PORT}/slack/events`);
})();

// Optional: Run immediately if RUN_ON_START env var is set
if (process.env.RUN_ON_START === "true") {
  sendDailyTasks().catch(console.error);
}