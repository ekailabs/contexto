Architecture Summary
┌─────────────────────────────────────────────────────────────┐
│                    YOUR DEPLOYMENTS                         │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. Website (contexto-website)                             │
│     - Landing page + waitlist/signup                       │
│     - Deploy to Vercel                                     │
│                                                             │
│  2. API Server (contexto/integrations/openrouter)          │
│     - OpenAI-compatible proxy with memory built-in        │
│     - Users point their agents here instead of OpenAI     │
│     - Deploy to AWS (ECS/EC2/Lambda)                      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│                    USER RUNS                                │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  OpenClaw (self-hosted)                                    │
│      │                                                     │
│      ├── has @ekai/contexto plugin installed              │
│      ├── plugin calls YOUR API Server for memory           │
│      └── stores memory in local SQLite                     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
---
What to Show on the Website
Change from "waitlist" to "usable product":
Section	Content
Hero	"Persistent memory for AI agents" + demo
How it works	Show the flow: user message → memory recall → context injected
Features	Conversation memory, semantic search, memory dashboard
Install	openclaw plugins install @ekai/contexto + config
API Demo	"Use without OpenClaw" - point to your deployed proxy
Pricing	$20/month (per CLAUDE.md SoftwareApplication schema)
CTA	"Get started" → signup/payment
---
AWS Deployment Steps for the Proxy API
Option A: ECS Fargate (Recommended)
# 1. Build and push Docker image
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <account>.dkr.ecr.us-east-1.amazonaws.com
docker build -t contexto-proxy .
docker tag contexto-proxy:latest <account>.dkr.ecr.us-east-1.amazonaws.com/contexto-proxy:latest
docker push <account>.dkr.ecr.us-east-1.amazonaws.com/contexto-proxy:latest
# 2. Create ECS cluster
aws ecs create-cluster --cluster-name contexto-cluster
# 3. Create task definition (contexto-task.json)
{
  "family": "contexto-proxy",
  "networkMode": "awsvpc",
  "containerDefinitions": [{
    "name": "contexto",
    "image": "<account>.dkr.ecr.us-east-1.amazonaws.com/contexto-proxy:latest",
    "essential": true,
    "portMappings": [{"containerPort": 4010, "protocol": "tcp"}],
    "environment": [
      {"name": "OPENROUTER_API_KEY", "value": "sk-..."},
      {"name": "ENABLE_DASHBOARD", "value": "false"}
    ],
    "logConfiguration": {"logDriver": "awslogs", "options": {"awslogs-group": "/ecs/contexto-proxy", "awslogs-region": "us-east-1"}}
  }]
}
# 4. Create service
aws ecs create-service --cluster contexto-cluster --service-name contexto-proxy --task-definition contexto-proxy --desired-count 1 --launch-type FARGATE --network-configuration "awsvpcConfiguration={subnets=[subnet-xxx],securityGroups=[sg-xxx]}"
# 5. Create ALB + target group pointing to port 4010
Option B: EC2 (Simpler, cheaper for low traffic)
# 1. Launch t3.small EC2 instance
# 2. Install Docker, Node.js
# 3. Deploy
git clone your-repo
cd contexto
npm install
npm run build
npm run start
# 4. Use systemd or pm2 to keep running
sudo tee /etc/systemd/system/contexto.service <<EOF
[Unit]
Description=Contexto Proxy
After=network.target
[Service]
Type=simple
User=ec2-user
WorkingDirectory=/home/ec2-user/contexto
ExecStart=/usr/bin/npm run start
Restart=always
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable contexto
sudo systemctl start contexto
Required Environment Variables
Variable
OPENROUTER_API_KEY
MEMORY_EMBED_PROVIDER
MEMORY_EXTRACT_PROVIDER
MEMORY_DB_PATH
ENABLE_DASHBOARD
OPENROUTER_PORT
Database Persistence
- Use AWS EFS or attach EBS volume to store memory.db
- Or use Amazon RDS SQLite (not ideal, but works)
---
Summary Checklist
Task
Website
Plugin
API Server
Domain
Billing
What do you want me to build first?