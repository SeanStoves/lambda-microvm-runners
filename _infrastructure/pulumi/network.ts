import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { AWS_REGION, NAME_PREFIX, ROLE_PREFIX, awsProvider } from "./config";

// Two AZs is plenty for a POC.
const AVAILABILITY_ZONES = [`${AWS_REGION}a`, `${AWS_REGION}b`];

// Gateway endpoints only. I had interface endpoints for secretsmanager/sqs/logs/lambda
// too, but with a NAT gateway already here they were just paying twice for the same
// path. Gateway endpoints are free, so those stay.
const GATEWAY_ENDPOINT_SERVICES = ["s3", "dynamodb"];

export interface NetworkResources {
  vpc: aws.ec2.Vpc;
  privateSubnetIds: pulumi.Output<string>[];
  lambdaSecurityGroup: aws.ec2.SecurityGroup;
}

export function createNetwork(): NetworkResources {
  const vpc = new aws.ec2.Vpc(
    `${NAME_PREFIX}-vpc`,
    {
      cidrBlock: "10.42.0.0/24",
      enableDnsSupport: true,
      enableDnsHostnames: true, // required for interface endpoint private DNS
      tags: { Name: `${NAME_PREFIX}-vpc` },
    },
    { provider: awsProvider },
  );

  const igw = new aws.ec2.InternetGateway(
    `${NAME_PREFIX}-igw`,
    { vpcId: vpc.id },
    { provider: awsProvider },
  );

  const publicSubnet = new aws.ec2.Subnet(
    `${NAME_PREFIX}-sub-public-a`,
    {
      vpcId: vpc.id,
      cidrBlock: "10.42.0.0/26",
      availabilityZone: AVAILABILITY_ZONES[0],
      mapPublicIpOnLaunch: true,
      tags: { Name: `${NAME_PREFIX}-sub-public-a` },
    },
    { provider: awsProvider },
  );

  const privateSubnetA = new aws.ec2.Subnet(
    `${NAME_PREFIX}-sub-private-a`,
    {
      vpcId: vpc.id,
      cidrBlock: "10.42.0.64/26",
      availabilityZone: AVAILABILITY_ZONES[0],
      tags: { Name: `${NAME_PREFIX}-sub-private-a` },
    },
    { provider: awsProvider },
  );

  const privateSubnetB = new aws.ec2.Subnet(
    `${NAME_PREFIX}-sub-private-b`,
    {
      vpcId: vpc.id,
      cidrBlock: "10.42.0.128/26",
      availabilityZone: AVAILABILITY_ZONES[1],
      tags: { Name: `${NAME_PREFIX}-sub-private-b` },
    },
    { provider: awsProvider },
  );

  // One NAT gateway. Lose that AZ and dispatch stops. Fine for a POC, not for anything real.
  const natEip = new aws.ec2.Eip(
    `${NAME_PREFIX}-eip-nat`,
    { domain: "vpc" },
    { provider: awsProvider },
  );

  const natGateway = new aws.ec2.NatGateway(
    `${NAME_PREFIX}-nat`,
    {
      subnetId: publicSubnet.id,
      allocationId: natEip.id,
    },
    { provider: awsProvider, dependsOn: [igw] },
  );

  const publicRouteTable = new aws.ec2.RouteTable(
    `${NAME_PREFIX}-rt-public`,
    {
      vpcId: vpc.id,
      routes: [{ cidrBlock: "0.0.0.0/0", gatewayId: igw.id }],
      tags: { Name: `${NAME_PREFIX}-rt-public` },
    },
    { provider: awsProvider },
  );

  new aws.ec2.RouteTableAssociation(
    `${NAME_PREFIX}-rta-public-a`,
    { subnetId: publicSubnet.id, routeTableId: publicRouteTable.id },
    { provider: awsProvider },
  );

  const privateRouteTable = new aws.ec2.RouteTable(
    `${NAME_PREFIX}-rt-private`,
    {
      vpcId: vpc.id,
      routes: [{ cidrBlock: "0.0.0.0/0", natGatewayId: natGateway.id }],
      tags: { Name: `${NAME_PREFIX}-rt-private` },
    },
    { provider: awsProvider },
  );

  new aws.ec2.RouteTableAssociation(
    `${NAME_PREFIX}-rta-private-a`,
    { subnetId: privateSubnetA.id, routeTableId: privateRouteTable.id },
    { provider: awsProvider },
  );

  new aws.ec2.RouteTableAssociation(
    `${NAME_PREFIX}-rta-private-b`,
    { subnetId: privateSubnetB.id, routeTableId: privateRouteTable.id },
    { provider: awsProvider },
  );

  // --------------------------------
  // VPC flow logs
  // --------------------------------

  const flowLogGroup = new aws.cloudwatch.LogGroup(
    `${NAME_PREFIX}-flow-logs`,
    {
      name: `/aws/vpc/${NAME_PREFIX}-flow-logs`,
      retentionInDays: 7,
    },
    { provider: awsProvider },
  );

  const flowLogAssumeRolePolicy = aws.iam.getPolicyDocumentOutput({
    statements: [
      {
        actions: ["sts:AssumeRole"],
        principals: [
          { type: "Service", identifiers: ["vpc-flow-logs.amazonaws.com"] },
        ],
      },
    ],
  });

  const flowLogRole = new aws.iam.Role(
    `${ROLE_PREFIX}-flowlogs`,
    {
      name: `${ROLE_PREFIX}-flowlogs`,
      assumeRolePolicy: flowLogAssumeRolePolicy.json,
    },
    { provider: awsProvider },
  );

  const flowLogPolicyDoc = aws.iam.getPolicyDocumentOutput({
    statements: [
      {
        actions: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogGroups",
          "logs:DescribeLogStreams",
        ],
        resources: [
          flowLogGroup.arn,
          pulumi.interpolate`${flowLogGroup.arn}:*`,
        ],
      },
    ],
  });

  new aws.iam.RolePolicy(
    `${NAME_PREFIX}-flowlogs-inline`,
    { role: flowLogRole.id, policy: flowLogPolicyDoc.json },
    { provider: awsProvider },
  );

  new aws.ec2.FlowLog(
    `${NAME_PREFIX}-flowlog`,
    {
      vpcId: vpc.id,
      trafficType: "ALL",
      logDestinationType: "cloud-watch-logs",
      logDestination: flowLogGroup.arn,
      iamRoleArn: flowLogRole.arn,
    },
    { provider: awsProvider },
  );

  // --------------------------------
  // Security group (shared by the Lambda functions)
  // --------------------------------

  const lambdaSecurityGroup = new aws.ec2.SecurityGroup(
    `${NAME_PREFIX}-sg-lambda`,
    {
      vpcId: vpc.id,
      description:
        "GHA MicroVM runner Lambdas: no inbound from outside the VPC, only outbound HTTPS.",
      egress: [
        {
          description:
            "HTTPS to GitHub API (via NAT) and to AWS service endpoints",
          protocol: "tcp",
          fromPort: 443,
          toPort: 443,
          cidrBlocks: ["0.0.0.0/0"],
        },
      ],
      // Egress only. Nothing needs to talk *to* these Lambdas inside the VPC.
      tags: { Name: `${NAME_PREFIX}-sg-lambda` },
    },
    { provider: awsProvider },
  );

  // --------------------------------
  // VPC endpoints
  // --------------------------------

  for (const service of GATEWAY_ENDPOINT_SERVICES) {
    new aws.ec2.VpcEndpoint(
      `${NAME_PREFIX}-vpce-${service}`,
      {
        vpcId: vpc.id,
        serviceName: `com.amazonaws.${AWS_REGION}.${service}`,
        vpcEndpointType: "Gateway",
        routeTableIds: [privateRouteTable.id],
        tags: { Name: `${NAME_PREFIX}-vpce-${service}` },
      },
      { provider: awsProvider },
    );
  }

  return {
    vpc,
    privateSubnetIds: [privateSubnetA.id, privateSubnetB.id],
    lambdaSecurityGroup,
  };
}
