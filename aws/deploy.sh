#!/usr/bin/env bash
set -euo pipefail

# Deploy Paperclip to AWS (us-east-1 default)
# Usage: ./aws/deploy.sh [--deepseek-key sk-...]

REGION="${AWS_REGION:-us-east-1}"
STACK_PREFIX="ola-paperclip"
INSTANCE_TYPE="${INSTANCE_TYPE:-t3.small}"
DB_CLASS="${DB_CLASS:-db.t4g.micro}"

DEEPSEEK_KEY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --deepseek-key) DEEPSEEK_KEY="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [[ -z "$DEEPSEEK_KEY" && -n "${DEEPSEEK_API_KEY:-}" ]]; then
  DEEPSEEK_KEY="$DEEPSEEK_API_KEY"
fi

echo "==> Region: $REGION"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
echo "==> Account: $ACCOUNT"

VPC_ID=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text --region "$REGION")
SUBNETS=$(aws ec2 describe-subnets --filters Name=vpc-id,Values="$VPC_ID" --query 'Subnets[*].SubnetId' --output text --region "$REGION")
SUBNET_A=$(echo "$SUBNETS" | awk '{print $1}')
SUBNET_B=$(echo "$SUBNETS" | awk '{print $2}')
echo "==> VPC: $VPC_ID  Subnets: $SUBNET_A $SUBNET_B"

BUCKET="${STACK_PREFIX}-uploads-${ACCOUNT}"
if ! aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "==> Creating S3 bucket $BUCKET"
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION"
fi

BETTER_AUTH=$(openssl rand -base64 48 | tr -d '/+=' | head -c 48)
DB_PASS=$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)

aws secretsmanager create-secret --name "${STACK_PREFIX}/better-auth-secret" \
  --secret-string "$BETTER_AUTH" --region "$REGION" 2>/dev/null \
  || aws secretsmanager put-secret-value --secret-id "${STACK_PREFIX}/better-auth-secret" \
  --secret-string "$BETTER_AUTH" --region "$REGION"

aws secretsmanager create-secret --name "${STACK_PREFIX}/db-password" \
  --secret-string "{\"username\":\"paperclip\",\"password\":\"$DB_PASS\"}" --region "$REGION" 2>/dev/null \
  || aws secretsmanager put-secret-value --secret-id "${STACK_PREFIX}/db-password" \
  --secret-string "{\"username\":\"paperclip\",\"password\":\"$DB_PASS\"}" --region "$REGION"

if [[ -n "$DEEPSEEK_KEY" ]]; then
  aws secretsmanager create-secret --name "${STACK_PREFIX}/deepseek-api-key" \
    --secret-string "$DEEPSEEK_KEY" --region "$REGION" 2>/dev/null \
    || aws secretsmanager put-secret-value --secret-id "${STACK_PREFIX}/deepseek-api-key" \
    --secret-string "$DEEPSEEK_KEY" --region "$REGION"
  echo "==> DeepSeek key stored in Secrets Manager"
else
  echo "==> WARN: No DeepSeek key — run deploy again with --deepseek-key sk-..."
fi

EC2_SG=$(aws ec2 describe-security-groups --filters "Name=group-name,Values=${STACK_PREFIX}-ec2" \
  --query 'SecurityGroups[0].GroupId' --output text --region "$REGION" 2>/dev/null || echo "None")
if [[ "$EC2_SG" == "None" || -z "$EC2_SG" ]]; then
  EC2_SG=$(aws ec2 create-security-group --group-name "${STACK_PREFIX}-ec2" \
    --description "Paperclip EC2" --vpc-id "$VPC_ID" --region "$REGION" --query GroupId --output text)
  aws ec2 authorize-security-group-ingress --group-id "$EC2_SG" --protocol tcp --port 22 --cidr 0.0.0.0/0 --region "$REGION" 2>/dev/null || true
  aws ec2 authorize-security-group-ingress --group-id "$EC2_SG" --protocol tcp --port 3100 --cidr 0.0.0.0/0 --region "$REGION" 2>/dev/null || true
fi

RDS_SG=$(aws ec2 describe-security-groups --filters "Name=group-name,Values=${STACK_PREFIX}-rds" \
  --query 'SecurityGroups[0].GroupId' --output text --region "$REGION" 2>/dev/null || echo "None")
if [[ "$RDS_SG" == "None" || -z "$RDS_SG" ]]; then
  RDS_SG=$(aws ec2 create-security-group --group-name "${STACK_PREFIX}-rds" \
    --description "Paperclip RDS" --vpc-id "$VPC_ID" --region "$REGION" --query GroupId --output text)
  aws ec2 authorize-security-group-ingress --group-id "$RDS_SG" --protocol tcp --port 5432 \
    --source-group "$EC2_SG" --region "$REGION" 2>/dev/null || true
fi

DB_ID="${STACK_PREFIX}-db"
DB_STATUS=$(aws rds describe-db-instances --db-instance-identifier "$DB_ID" --region "$REGION" \
  --query 'DBInstances[0].DBInstanceStatus' --output text 2>/dev/null || echo "missing")

if [[ "$DB_STATUS" == "missing" ]]; then
  echo "==> Creating RDS PostgreSQL (5-10 min)..."
  aws rds create-db-subnet-group --db-subnet-group-name "${STACK_PREFIX}-subnets" \
    --db-subnet-group-description "Paperclip" \
    --subnet-ids "$SUBNET_A" "$SUBNET_B" --region "$REGION" 2>/dev/null || true

  aws rds create-db-instance \
    --db-instance-identifier "$DB_ID" \
    --db-instance-class "$DB_CLASS" \
    --engine postgres \
    --engine-version "17" \
    --master-username paperclip \
    --master-user-password "$DB_PASS" \
    --allocated-storage 20 \
    --db-name paperclip \
    --vpc-security-group-ids "$RDS_SG" \
    --db-subnet-group-name "${STACK_PREFIX}-subnets" \
    --backup-retention-period 1 \
    --no-publicly-accessible \
    --region "$REGION"

  echo "==> Waiting for RDS..."
  aws rds wait db-instance-available --db-instance-identifier "$DB_ID" --region "$REGION"
else
  echo "==> RDS already exists: $DB_ID ($DB_STATUS)"
fi

DB_HOST=$(aws rds describe-db-instances --db-instance-identifier "$DB_ID" --region "$REGION" \
  --query 'DBInstances[0].Endpoint.Address' --output text)
DATABASE_URL="postgres://paperclip:${DB_PASS}@${DB_HOST}:5432/paperclip"
echo "==> RDS endpoint: $DB_HOST"

# IAM role for EC2
ROLE_NAME="${STACK_PREFIX}-ec2-role"
if ! aws iam get-role --role-name "$ROLE_NAME" 2>/dev/null; then
  aws iam create-role --role-name "$ROLE_NAME" --assume-role-policy-document '{
    "Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
  aws iam attach-role-policy --role-name "$ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
  aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name paperclip-app --policy-document "{
    \"Version\":\"2012-10-17\",
    \"Statement\":[
      {\"Effect\":\"Allow\",\"Action\":[\"secretsmanager:GetSecretValue\"],\"Resource\":\"arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:${STACK_PREFIX}/*\"},
      {\"Effect\":\"Allow\",\"Action\":[\"s3:*\"],\"Resource\":[\"arn:aws:s3:::${BUCKET}\",\"arn:aws:s3:::${BUCKET}/*\"]}
    ]}"
  aws iam create-instance-profile --instance-profile-name "$ROLE_NAME" 2>/dev/null || true
  aws iam add-role-to-instance-profile --instance-profile-name "$ROLE_NAME" --role-name "$ROLE_NAME" 2>/dev/null || true
  sleep 10
fi

INSTANCE_ID=$(aws ec2 describe-instances --region "$REGION" \
  --filters "Name=tag:Name,Values=${STACK_PREFIX}" "Name=instance-state-name,Values=running,pending" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null || echo "None")

if [[ "$INSTANCE_ID" == "None" || -z "$INSTANCE_ID" ]]; then
  # Pre-allocate Elastic IP so auth URL is correct on first boot
  ALLOC=$(aws ec2 allocate-address --domain vpc --region "$REGION" --query AllocationId --output text)
  PUBLIC_IP=$(aws ec2 describe-addresses --allocation-ids "$ALLOC" --region "$REGION" --query 'Addresses[0].PublicIp' --output text)
  aws ec2 create-tags --resources "$ALLOC" --tags Key=Name,Value="${STACK_PREFIX}-eip" --region "$REGION"
  PAPERCLIP_PUBLIC_URL="http://${PUBLIC_IP}:3100"

  AMI=$(aws ssm get-parameters --names /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
    --query 'Parameters[0].Value' --output text --region "$REGION")

  USER_DATA=$(cat <<'USERDATA'
#!/bin/bash
set -e
dnf install -y docker git jq
systemctl enable --now docker
usermod -aG docker ec2-user

REGION=__REGION__
STACK_PREFIX=ola-paperclip
BUCKET=__BUCKET__
PUBLIC_URL=__PUBLIC_URL__

mkdir -p /opt/paperclip && cd /opt/paperclip
git clone https://github.com/olanotolu/Ola.git repo || (cd repo && git pull)
cd repo/aws

BETTER_AUTH=$(aws secretsmanager get-secret-value --secret-id ${STACK_PREFIX}/better-auth-secret --region $REGION --query SecretString --output text)
DB_JSON=$(aws secretsmanager get-secret-value --secret-id ${STACK_PREFIX}/db-password --region $REGION --query SecretString --output text)
DB_PASS=$(echo "$DB_JSON" | jq -r .password)
DB_HOST=__DB_HOST__
DEEPSEEK=$(aws secretsmanager get-secret-value --secret-id ${STACK_PREFIX}/deepseek-api-key --region $REGION --query SecretString --output text 2>/dev/null || echo "")

export AWS_REGION=$REGION
export DATABASE_URL="postgres://paperclip:${DB_PASS}@${DB_HOST}:5432/paperclip"
export BETTER_AUTH_SECRET="$BETTER_AUTH"
export DEEPSEEK_API_KEY="$DEEPSEEK"
export PAPERCLIP_S3_BUCKET="$BUCKET"
export PAPERCLIP_PUBLIC_URL="$PUBLIC_URL"
export PAPERCLIP_DEPLOYMENT_MODE=authenticated
export PAPERCLIP_DEPLOYMENT_EXPOSURE=public
export PAPERCLIP_AUTH_PUBLIC_BASE_URL="$PUBLIC_URL"
export PAPERCLIP_AUTH_BASE_URL_MODE=explicit
export PAPERCLIP_STORAGE_PROVIDER=s3
export PAPERCLIP_STORAGE_S3_BUCKET="$BUCKET"
export PAPERCLIP_STORAGE_S3_REGION="$REGION"

docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
USERDATA
)
  USER_DATA="${USER_DATA//__REGION__/$REGION}"
  USER_DATA="${USER_DATA//__BUCKET__/$BUCKET}"
  USER_DATA="${USER_DATA//__DB_HOST__/$DB_HOST}"
  USER_DATA="${USER_DATA//__PUBLIC_URL__/$PAPERCLIP_PUBLIC_URL}"

  INSTANCE_ID=$(aws ec2 run-instances \
    --image-id "$AMI" \
    --instance-type "$INSTANCE_TYPE" \
    --iam-instance-profile Name="$ROLE_NAME" \
    --security-group-ids "$EC2_SG" \
    --subnet-id "$SUBNET_A" \
    --associate-public-ip-address \
    --user-data "$USER_DATA" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=${STACK_PREFIX}}]" \
    --region "$REGION" \
    --query Instances[0].InstanceId --output text)

  echo "==> Launched EC2: $INSTANCE_ID"
  aws ec2 wait instance-running --instance-ids "$INSTANCE_ID" --region "$REGION"
  aws ec2 associate-address --instance-id "$INSTANCE_ID" --allocation-id "$ALLOC" --region "$REGION"
fi

PUBLIC_IP=$(aws ec2 describe-addresses --region "$REGION" \
  --filters "Name=tag:Name,Values=${STACK_PREFIX}-eip" \
  --query 'Addresses[0].PublicIp' --output text 2>/dev/null)
if [[ -z "$PUBLIC_IP" || "$PUBLIC_IP" == "None" ]]; then
  PUBLIC_IP=$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" --region "$REGION" \
    --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
fi

PAPERCLIP_URL="http://${PUBLIC_IP}:3100"
echo ""
echo "============================================"
echo "  Paperclip AWS deploy complete"
echo "============================================"
echo "  URL:      $PAPERCLIP_URL"
echo "  Health:   $PAPERCLIP_URL/api/health"
echo "  EC2:      $INSTANCE_ID"
echo "  RDS:      $DB_HOST"
echo "  S3:       s3://$BUCKET"
echo ""
echo "  First boot takes ~3-5 min (docker build)."
echo "  Check logs: aws ssm start-session --target $INSTANCE_ID"
echo "              then: sudo docker compose -f /opt/paperclip/repo/aws/docker-compose.prod.yml logs -f"
echo ""
echo "  Set PAPERCLIP_AUTH_PUBLIC_BASE_URL to $PAPERCLIP_URL on the instance"
echo "  after Paperclip is up, then restart the container."
echo "============================================"

# Save state locally
mkdir -p "$(dirname "$0")/../.aws-deploy"
cat > "$(dirname "$0")/../.aws-deploy/state.env" <<STATE
PAPERCLIP_URL=$PAPERCLIP_URL
INSTANCE_ID=$INSTANCE_ID
DB_HOST=$DB_HOST
BUCKET=$BUCKET
REGION=$REGION
STATE
