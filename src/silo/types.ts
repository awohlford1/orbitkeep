export interface SiloOriginHint {
  provider: "github" | "gitlab" | "bitbucket" | "other";
  repository: string;
}

export interface SiloDescriptor {
  schema_version: "1.0";
  silo_id: string;
  created_at: string;
  identity_version: number;
  derived_from_silo_id?: string;
  origin_hint?: SiloOriginHint;
}

export interface SiloInstance {
  schema_version: "1.0";
  silo_instance_id: string;
  silo_id: string;
  created_at: string;
  last_started_at: string;
  instance_version: number;
  workspace_fingerprint: string;
}

export interface SiloIdentityInspection {
  valid: boolean;
  descriptor?: SiloDescriptor;
  instance?: SiloInstance;
  errors: Array<{ code: "SILO_IDENTITY_MISSING" | "SILO_IDENTITY_INVALID" | "SILO_INSTANCE_MISMATCH"; message: string }>;
}

export interface SiloIdentityInitialization {
  descriptor: SiloDescriptor;
  instance: SiloInstance;
  descriptorCreated: boolean;
  instanceCreated: boolean;
}

export interface SiloIdentityDerivation {
  previousSiloId: string;
  descriptor: SiloDescriptor;
  instance: SiloInstance;
}
