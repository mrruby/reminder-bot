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
    
    // The API might return the data in a different structure
    let tasks: NozbeTask[] = [];
    
    // Check if response.data is an array or an object
    if (response.data) {
      if (Array.isArray(response.data)) {
        tasks = response.data;
      } else if (typeof response.data === 'object' && response.data.items) {
        // Check if data is wrapped in an object with 'items' property
        tasks = response.data.items;
      } else if (typeof response.data === 'object' && response.data.tasks) {
        // Check if data is wrapped in an object with 'tasks' property
        tasks = response.data.tasks;
      } else {
        // If it's a single object, wrap it in an array
        tasks = [response.data];
      }
    }
    
    return tasks.filter((task: NozbeTask) => !task.completed);
  } catch (error) {
    throw error;
  }
}

async function markTaskComplete(taskId: string): Promise<boolean> {
  
  try {
    // Use form-encoded data which works with Nozbe API
    const formData = new URLSearchParams();
    formData.append('id', taskId);
    formData.append('completed', 'true');
    
    await axios.put(
      `${NOZBE_API_URL}/task`,
      formData,
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Authorization": NOZBE_API_KEY,
          "Client": NOZBE_CLIENT_ID,
        },
      }
    );
    
    return true;
  } catch (error: any) {
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
    description: task.datetime 
      ? {
          type: "plain_text",
          text: `Due: ${format(new Date(task.datetime), "MMM d, h:mm a")}`,
        }
      : undefined,
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
  
  // Type guard for checkbox action
  if (action.type === "checkboxes" && body.type === "block_actions" && body.message) {
    const selectedTasks = action.selected_options || [];
    const checkedTaskIds = selectedTasks
      .map((opt) => opt.value)
      .filter((value): value is string => value !== undefined);
    
    // Mark tasks as complete in Nozbe
    for (const taskId of checkedTaskIds) {
      await markTaskComplete(taskId);
    }
    
    // Update the original message to remove completed tasks
    if (checkedTaskIds.length > 0) {
      const channelId = body.channel?.id || SLACK_USER_ID;
      const messageTs = body.message.ts;
      
      // Get the current blocks from the message
      const currentBlocks = body.message.blocks || [];
      
      // Update the blocks to remove completed tasks
      const updatedBlocks: any[] = [];
      
      for (const block of currentBlocks) {
        // For actions blocks with checkboxes, check if tasks remain
        if (block.type === 'actions') {
          let hasRemainingTasks = false;
          const updatedElements = block.elements.map((element: any) => {
            if (element.type === 'checkboxes') {
              const remainingOptions = element.options.filter((opt: any) => 
                !checkedTaskIds.includes(opt.value)
              );
              
              hasRemainingTasks = remainingOptions.length > 0;
              
              return {
                ...element,
                options: remainingOptions
              };
            }
            return element;
          });
          
          // Only keep actions block if tasks remain
          if (hasRemainingTasks) {
            updatedBlocks.push({
              ...block,
              elements: updatedElements
            });
          } else {
            updatedBlocks.push({
              type: "section",
              text: {
                type: "mrkdwn",
                text: "✅ All tasks completed! Great job! 🎉"
              }
            });
          }
        } else {
          // Keep all other blocks
          updatedBlocks.push(block);
        }
      }
      
      // Update the message
      if (channelId && messageTs) {
        try {
          await client.chat.update({
            channel: channelId,
            ts: messageTs,
            blocks: updatedBlocks,
            text: "Daily Tasks" // Fallback text
          });
        } catch (error) {
        }
      }
    }
  }
});

// Add custom routes to Express receiver
receiver.router.get("/trigger", async (_req: any, res: any) => {
  
  try {
    await sendDailyTasks();
    res.json({ success: true, message: "Daily tasks sent to Slack" });
  } catch (error) {
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
      return result.channel.id;
    }
    
    throw new Error("Failed to open DM channel");
  } catch (error) {
    throw error;
  }
}

// Main function to send daily tasks
async function sendDailyTasks() {
  
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
    
    // Fetch conversation history
    const history = await slackApp.client.conversations.history({
      channel: dmChannel,
      limit: 100, // Fetch last 100 messages
    });
    
    if (history.messages) {
      // Find and delete bot messages
      const botMessages = history.messages.filter((msg) => msg.bot_id);
      
      
      // Delete each bot message
      for (const msg of botMessages) {
        if (msg.ts) {
          try {
            await slackApp.client.chat.delete({
              channel: dmChannel,
              ts: msg.ts,
            });
          } catch (deleteError) {
            // Silently continue if we can't delete a message
            // Silently continue if we can't delete a message
          }
        }
      }
      
    }
  } catch (error) {
    // Continue anyway - not critical if we can't delete old messages
  }
  
  // Fetch tasks from Nozbe
  const tasks = await fetchNozebTasks(NOZBE_PROJECT_ID);
  
  if (tasks.length === 0) {
    const message = {
      channel: dmChannel,
      text: "🎉 No tasks for today - you're all caught up!",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "🎉 *No tasks for today* - you're all caught up!",
          },
        },
      ],
    };
    
    await slackApp.client.chat.postMessage(message);
    return;
  }
  
  // Select top 3 tasks
  const top3Tasks = tasks.slice(0, 3);
  
  // Build and send message
  const message = buildTaskMessage(top3Tasks, dmChannel);
  const result = await slackApp.client.chat.postMessage(message);
  
  if (result.ok) {
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
  sendDailyTasks().catch(() => {});
}