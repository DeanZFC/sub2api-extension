export type UserRole = 'user' | 'admin'

export interface SessionUser {
  id: number
  email: string
  username?: string
  role: UserRole
  current_balance?: number
  recharge_total?: number
  recent_recharge_totals?: Record<string, number>
  has_recharged?: boolean
}

export interface Session {
  authenticated: boolean
  user: SessionUser
  csrf_token?: string
  time_zone?: string
}

export interface RequestLog {
  id: string
  request_id: string
  created_at: string
  last_seen_at: string
  request_count: number
  duration_ms: number
  ip_address: string
  user_id: number | null
  role: string
  method: string
  path: string
  route_pattern: string
  status_code: number
  result_code: string
  rate_limit_scope: string
  user_agent: string
}

export interface RequestLogPage {
  items: RequestLog[]
  total: number
  page: number
  page_size: number
  pages: number
}

export type FactKey = 'current_balance' | 'recharge_total' | 'recent_recharge_total'
export type NumericOperator = 'gt' | 'gte' | 'eq' | 'lt' | 'lte'
export type ConditionOperator = NumericOperator
export type LogicOperator = 'and' | 'or'

export interface FactCondition {
  type: 'fact'
  fact: FactKey
  operator: ConditionOperator
  value: number
  window_days?: number
}

export interface ConditionGroup {
  type: 'group'
  operator: LogicOperator
  children: ConditionNode[]
}

export type ConditionNode = FactCondition | ConditionGroup

export interface UserFacts {
  current_balance: number
  recharge_total: number
  recent_recharge_totals?: Record<string, number>
  has_recharged?: boolean
}

export interface Sub2ApiGroup {
  id: number
  name: string
  multiplier?: number
  exclusive: boolean
  status: 'active' | 'inactive'
  subscription_type?: string
  rule_id?: string
  rule_enabled?: boolean
}

export interface GroupGrantRule {
  id: string
  name: string
  group_id: number
  group_name?: string
  enabled: boolean
  assignment_mode: 'claim'
  activity_description: string
  activity_starts_at?: string | null
  activity_ends_at?: string | null
  revoke_at?: string | null
  revoke_when_ineligible: boolean
  condition: ConditionNode
  last_execution?: GroupGrantExecution
  created_at: string
  updated_at: string
}

export type GroupGrantRuleInput = Pick<
  GroupGrantRule,
  | 'name'
  | 'group_id'
  | 'enabled'
  | 'revoke_when_ineligible'
  | 'assignment_mode'
  | 'activity_description'
  | 'activity_starts_at'
  | 'activity_ends_at'
  | 'revoke_at'
  | 'condition'
>

export type GroupGrantExecutionStatus = 'running' | 'succeeded' | 'partial' | 'failed'

export interface GroupGrantStats {
  scanned_count: number
  eligible_count: number
  managed_count: number
  preexisting_count: number
  granted_count: number
  revoked_count: number
  unchanged_count: number
  failed_count: number
}

export interface GroupGrantPreview extends GroupGrantStats {
  rule_id: string
  generated_at?: string
}

export interface GroupGrantExecution extends GroupGrantStats {
  id: string
  rule_id: string
  rule_name?: string
  group_id: number
  group_name?: string
  mode: 'preview' | 'execute' | 'revoke' | 'expire'
  status: GroupGrantExecutionStatus
  error?: string
  started_at: string
  completed_at?: string
}

export type LotteryStatus =
  | 'not_started'
  | 'active'
  | 'snapshot_ready'
  | 'locked'
  | 'drawn'
  | 'fulfilling'
  | 'fulfilled'
  | 'failed'

export type RewardType = 'balance' | 'concurrency' | 'subscription' | 'physical' | 'manual'

export interface LotteryPrize {
  id?: string
  name: string
  winner_count: number
  reward_type: RewardType
  reward_value: number
  group_id?: number
  group_name?: string
  validity_days?: number
  sort_order: number
}

export interface ExclusionReason {
  code: string
  label: string
  count: number
}

export interface CandidateSnapshot {
  id: string
  user_id: number
  email: string
  eligible: boolean
  facts: UserFacts
  exclusion_reasons: string[]
  snapshot_at: string
}

export type FulfillmentStatus = 'pending' | 'processing' | 'succeeded' | 'failed' | 'manual'

export interface LotteryWinner {
  id: string
  user_id: number
  email: string
  prize_name: string
  reward_value?: number
  fulfillment_status: FulfillmentStatus
  fulfillment_id?: string
  fulfillment_error?: string
  drawn_at: string
}

export interface FulfillmentJob {
  id: string
  winner_id: string
  user_id: number
  lottery_id: string
  type: string
  status: FulfillmentStatus
  attempts: number
  error?: string
  external_ref?: string
  created_at: string
  updated_at: string
}

export interface Lottery {
  id: string
  name: string
  description: string
  status: LotteryStatus
  published: boolean
  starts_at?: string | null
  ends_at?: string | null
  auto_draw_at?: string | null
  auto_draw_attempted_at?: string
  auto_draw_error?: string
  winners_count: number
  prizes: LotteryPrize[]
  condition: ConditionNode
  entry_count: number
  candidate_count: number
  excluded_count: number
  snapshot_at?: string
  locked_at?: string
  drawn_at?: string
  exclusion_summary?: ExclusionReason[]
  candidates?: CandidateSnapshot[]
  winners?: LotteryWinner[]
  created_at: string
  updated_at: string
}

export type LotteryInput = Pick<
  Lottery,
  | 'name'
  | 'description'
  | 'starts_at'
  | 'ends_at'
  | 'auto_draw_at'
  | 'prizes'
  | 'condition'
>

export type ActivityType = 'lottery' | 'checkin' | 'group_entitlement'
export type ActivityStatus = 'active' | 'upcoming' | 'ended'

export interface UserActivity {
  id: string
  type: ActivityType
  name: string
  description: string
  status: ActivityStatus
  phase?: LotteryStatus
  starts_at?: string | null
  ends_at?: string | null
  auto_draw_at?: string | null
  drawn_at?: string | null
  action_label: string
  group_id?: number
  group_name?: string
  reward?: { type: 'none' | 'balance'; value: number }
  participation?: {
    participated?: boolean
    checked_today?: boolean
    total_days?: number
    streak_days?: number
    reward_status?: string
    today?: string
    current_month?: string
    checked_dates?: string[]
    eligibility_confirmed?: boolean
    eligible?: boolean | null
    granted?: boolean
    won?: boolean
    reasons?: string[]
  }
  condition?: ConditionNode
  facts?: UserFacts
  eligible?: boolean | null
  eligibility_confirmed?: boolean
  participated?: boolean
  granted?: boolean
  already_granted?: boolean
  reasons?: string[]
  prizes?: LotteryPrize[]
  winner?: {
    prize_name: string
    reward_type: string
    reward_value: number
    reward_status: string
    drawn_at: string
  } | null
  updated_at: string
}

export interface CheckinCampaign {
  id: string
  name: string
  description: string
  published: boolean
  condition: ConditionNode
  reward_type: 'none' | 'balance'
  reward_value: number
  starts_at?: string | null
  ends_at?: string | null
  record_count: number
  participant_count: number
  created_at: string
  updated_at: string
}

export type CheckinCampaignInput = Pick<
  CheckinCampaign,
  | 'name'
  | 'description'
  | 'published'
  | 'condition'
  | 'reward_type'
  | 'reward_value'
  | 'starts_at'
  | 'ends_at'
>

export interface SyncResult {
  started_at: string
  completed_at: string
  users_scanned: number
  users_updated: number
  errors: number
}

export interface PageResult<T> {
  items: T[]
  total: number
}
