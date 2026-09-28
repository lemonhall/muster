# 覆盖矩阵（脚本生成，请勿手改）

这份表回答一个问题：**上游测试套件里的每一条，在我们的项目里到底有着落没有。**

状态判定全部由脚本完成，不靠人填表：`ported` = 我们的测试里写了 `溯源:` 指向它；
`exempt` = 在 `docs/conformance/exemptions.json` 里且写了理由；其余一律 `planned`。
`planned` 不是失败，是**待办**；但它在任何声称已交付的里程碑范围内出现，就是断链。

| 项目 | 值 |
|---|---|
| 上游 commit | `e920249a3465bea4b8ea2968020c488201b61a8e` |
| 上游测试条目 | 263 |
| ported | 0 |
| planned | 263 |
| exempt | 0 |
| 无理由豁免 | 0 |
| 第二证据源引用（自主契约测试） | 5 |

## 按里程碑

| 里程碑 | 范围 | 条目 | ported | planned | exempt |
|---|---|---:|---:|---:|---:|
| M1 | 身份与账号 | 4 | 0 | 4 | 0 |
| M2 | 存储引擎 | 57 | 0 | 57 | 0 |
| M3 | 实时协议与在线状态 | 1 | 0 | 1 | 0 |
| M4 | 频道与聊天 | 0 | 0 | 0 | 0 |
| M5 | 社交（好友/群组/通知） | 1 | 0 | 1 | 0 |
| M6 | 经济与竞技（钱包/排行榜/锦标赛） | 25 | 0 | 25 | 0 |
| M7 | 匹配与对局 | 35 | 0 | 35 | 0 |
| M8 | 派对与运行时扩展 | 44 | 0 | 44 | 0 |
| M9 | 管理台与运维面 | 5 | 0 | 5 | 0 |
| MX | 横切（配置/指标/关停/流管理） | 4 | 0 | 4 | 0 |
| LUA | Lua 运行时（后置，不属于 v1~v4 的 P0/P1） | 76 | 0 | 76 | 0 |
| ALG | 上游内部算法（本项目按自己的数据结构重写，只对齐可观测行为） | 9 | 0 | 9 | 0 |
| NS | 非目标（上游商业控制台的数据面） | 2 | 0 | 2 | 0 |

## 逐条清单

### M1 身份与账号

| # | 状态 | 上游测试 | 文件 | 证据 / 理由 |
|---:|---|---|---|---|
| 1 | planned | TestWWWAuthenticateHeaderOnUnauthenticated | `server/api_test.go` | — |
| 2 | planned | TestCheckGoogleTokenDoesNotExchangeMalformedJWT | `social/google_token_audience_test.go` | — |
| 3 | planned | TestCheckGoogleTokenPreservesAuthorizationCodeFlow | `social/google_token_audience_test.go` | — |
| 4 | planned | TestCheckGoogleTokenValidatesAudience | `social/google_token_audience_test.go` | — |

### M2 存储引擎

| # | 状态 | 上游测试 | 文件 | 证据 / 理由 |
|---:|---|---|---|---|
| 5 | planned | TestNonOCCAuthoritative | `server/core_storage_test.go` | — |
| 6 | planned | TestNonOCCNonAuthoritative | `server/core_storage_test.go` | — |
| 7 | planned | TestOCCNotExistsAuthoritative | `server/core_storage_test.go` | — |
| 8 | planned | TestOCCNotExistsNonAuthoritative | `server/core_storage_test.go` | — |
| 9 | planned | TestOCCWriteAuthoritative | `server/core_storage_test.go` | — |
| 10 | planned | TestOCCWriteNonAuthoritative | `server/core_storage_test.go` | — |
| 11 | planned | TestOCCWriteSameValueCorrectVersionSuccess | `server/core_storage_test.go` | — |
| 12 | planned | TestOCCWriteSameValueWithOutdatedVersionFail | `server/core_storage_test.go` | — |
| 13 | planned | TestStorageFetchPipelineGlobalPrivate | `server/core_storage_test.go` | — |
| 14 | planned | TestStorageFetchPipelineUserOtherPublic | `server/core_storage_test.go` | — |
| 15 | planned | TestStorageFetchPipelineUserOtherPublicMixed | `server/core_storage_test.go` | — |
| 16 | planned | TestStorageFetchPipelineUserOtherRead | `server/core_storage_test.go` | — |
| 17 | planned | TestStorageFetchPipelineUserPrivate | `server/core_storage_test.go` | — |
| 18 | planned | TestStorageFetchPipelineUserPublic | `server/core_storage_test.go` | — |
| 19 | planned | TestStorageFetchPipelineUserRead | `server/core_storage_test.go` | — |
| 20 | planned | TestStorageFetchRuntimeGlobalPrivate | `server/core_storage_test.go` | — |
| 21 | planned | TestStorageFetchRuntimeMixed | `server/core_storage_test.go` | — |
| 22 | planned | TestStorageFetchRuntimeUserPrivate | `server/core_storage_test.go` | — |
| 23 | planned | TestStorageListNoRepeats | `server/core_storage_test.go` | — |
| 24 | planned | TestStorageListPipelineUserOther | `server/core_storage_test.go` | — |
| 25 | planned | TestStorageListPipelineUserSelf | `server/core_storage_test.go` | — |
| 26 | planned | TestStorageListRuntimeUser | `server/core_storage_test.go` | — |
| 27 | planned | TestStorageOverrwriteEmptyAndNonEmptyVersions | `server/core_storage_test.go` | — |
| 28 | planned | TestStorageReadObjectsAllDistinctArgs | `server/core_storage_test.go` | — |
| 29 | planned | TestStorageReadObjectsOneDistinctArg | `server/core_storage_test.go` | — |
| 30 | planned | TestStorageReadObjectsSameArgs | `server/core_storage_test.go` | — |
| 31 | planned | TestStorageReadObjectsTwoDistinctArgs | `server/core_storage_test.go` | — |
| 32 | planned | TestStorageRemovePipelineUserDenied | `server/core_storage_test.go` | — |
| 33 | planned | TestStorageRemovePipelineUserWrite | `server/core_storage_test.go` | — |
| 34 | planned | TestStorageRemoveRuntimeGlobalIfMatch | `server/core_storage_test.go` | — |
| 35 | planned | TestStorageRemoveRuntimeGlobalIfMatchNotExists | `server/core_storage_test.go` | — |
| 36 | planned | TestStorageRemoveRuntimeGlobalIfMatchRejected | `server/core_storage_test.go` | — |
| 37 | planned | TestStorageRemoveRuntimeGlobalPrivate | `server/core_storage_test.go` | — |
| 38 | planned | TestStorageRemoveRuntimeGlobalPublic | `server/core_storage_test.go` | — |
| 39 | planned | TestStorageRemoveRuntimeUserPrivate | `server/core_storage_test.go` | — |
| 40 | planned | TestStorageRemoveRuntimeUserPublic | `server/core_storage_test.go` | — |
| 41 | planned | TestStorageWritePipelineIfMatchExists | `server/core_storage_test.go` | — |
| 42 | planned | TestStorageWritePipelineIfMatchExistsFail | `server/core_storage_test.go` | — |
| 43 | planned | TestStorageWritePipelineIfMatchNotExists | `server/core_storage_test.go` | — |
| 44 | planned | TestStorageWritePipelineIfNoneMatchExists | `server/core_storage_test.go` | — |
| 45 | planned | TestStorageWritePipelineIfNoneMatchNotExists | `server/core_storage_test.go` | — |
| 46 | planned | TestStorageWritePipelinePermissionFail | `server/core_storage_test.go` | — |
| 47 | planned | TestStorageWritePipelineUserMultiple | `server/core_storage_test.go` | — |
| 48 | planned | TestStorageWritePipelineUserMultipleSameKey | `server/core_storage_test.go` | — |
| 49 | planned | TestStorageWritePipelineUserSingle | `server/core_storage_test.go` | — |
| 50 | planned | TestStorageWriteRuntimeGlobalMultipleIfMatchNotExists | `server/core_storage_test.go` | — |
| 51 | planned | TestStorageWriteRuntimeGlobalMultipleSameKey | `server/core_storage_test.go` | — |
| 52 | planned | TestStorageWriteRuntimeGlobalSingle | `server/core_storage_test.go` | — |
| 53 | planned | TestStorageWriteRuntimeGlobalSingleIfMatchExists | `server/core_storage_test.go` | — |
| 54 | planned | TestStorageWriteRuntimeGlobalSingleIfMatchExistsFail | `server/core_storage_test.go` | — |
| 55 | planned | TestStorageWriteRuntimeGlobalSingleIfMatchNotExists | `server/core_storage_test.go` | — |
| 56 | planned | TestStorageWriteRuntimeGlobalSingleIfNoneMatchExists | `server/core_storage_test.go` | — |
| 57 | planned | TestStorageWriteRuntimeGlobalSingleIfNoneMatchNotExists | `server/core_storage_test.go` | — |
| 58 | planned | TestStorageWriteRuntimeUserMultiple | `server/core_storage_test.go` | — |
| 59 | planned | TestLocalStorageIndex_Delete | `server/storage_index_test.go` | — |
| 60 | planned | TestLocalStorageIndex_List | `server/storage_index_test.go` | — |
| 61 | planned | TestLocalStorageIndex_Write | `server/storage_index_test.go` | — |

### M3 实时协议与在线状态

| # | 状态 | 上游测试 | 文件 | 证据 / 理由 |
|---:|---|---|---|---|
| 62 | planned | TestWebSocketRejectsSessionAfterLogout | `server/socket_ws_test.go` | — |

### M5 社交（好友/群组/通知）

| # | 状态 | 上游测试 | 文件 | 证据 / 理由 |
|---:|---|---|---|---|
| 63 | planned | TestServer_ListFriendsOfFriends | `server/core_friend_test.go` | — |

### M6 经济与竞技（钱包/排行榜/锦标赛）

| # | 状态 | 上游测试 | 文件 | 证据 / 理由 |
|---:|---|---|---|---|
| 64 | planned | TestApiLeaderboard | `server/api_leaderboard_test.go` | — |
| 65 | planned | TestApiTournamentHaystack | `server/api_tournament_test.go` | — |
| 66 | planned | TestTournamentEveryDayMonThruFri | `server/core_tournament_test.go` | — |
| 67 | planned | TestTournamentEveryFourteenDaysFromFirst | `server/core_tournament_test.go` | — |
| 68 | planned | TestTournamentNowIsBeforeStart | `server/core_tournament_test.go` | — |
| 69 | planned | TestTournamentNowIsResetTime | `server/core_tournament_test.go` | — |
| 70 | planned | TestUpdateWalletMultiUser | `server/core_wallet_test.go` | — |
| 71 | planned | TestUpdateWalletRepeatedSingleUser | `server/core_wallet_test.go` | — |
| 72 | planned | TestUpdateWalletSingleUser | `server/core_wallet_test.go` | — |
| 73 | planned | TestUpdateWalletsMultiUser | `server/core_wallet_test.go` | — |
| 74 | planned | TestUpdateWalletsMultiUserSharedChangeset | `server/core_wallet_test.go` | — |
| 75 | planned | TestUpdateWalletsMultiUserSharedChangesetDeductions | `server/core_wallet_test.go` | — |
| 76 | planned | TestUpdateWalletsSingleUser | `server/core_wallet_test.go` | — |
| 77 | planned | TestLocalLeaderboardRankCache_Delete | `server/leaderboard_rank_cache_test.go` | — |
| 78 | planned | TestLocalLeaderboardRankCache_DeleteLeaderboard | `server/leaderboard_rank_cache_test.go` | — |
| 79 | planned | TestLocalLeaderboardRankCache_ExpirySeparation | `server/leaderboard_rank_cache_test.go` | — |
| 80 | planned | TestLocalLeaderboardRankCache_Fill | `server/leaderboard_rank_cache_test.go` | — |
| 81 | planned | TestLocalLeaderboardRankCache_Insert_Ascending | `server/leaderboard_rank_cache_test.go` | — |
| 82 | planned | TestLocalLeaderboardRankCache_Insert_Descending | `server/leaderboard_rank_cache_test.go` | — |
| 83 | planned | TestLocalLeaderboardRankCache_Insert_Existing | `server/leaderboard_rank_cache_test.go` | — |
| 84 | planned | TestLocalLeaderboardRankCache_LeaderboardSeparation | `server/leaderboard_rank_cache_test.go` | — |
| 85 | planned | TestLocalLeaderboardRankCache_TrimExpired | `server/leaderboard_rank_cache_test.go` | — |
| 86 | planned | TestLeaderboardScheduler | `server/leaderboard_scheduler_test.go` | — |
| 87 | planned | TestLeaderboardSchedulerEndedTournamentHidesLiveExpiry | `server/leaderboard_scheduler_test.go` | — |
| 88 | planned | TestLeaderboardSchedulerEndedTournamentHidesSuccessorExpiry | `server/leaderboard_scheduler_test.go` | — |

### M7 匹配与对局

| # | 状态 | 上游测试 | 文件 | 证据 / 理由 |
|---:|---|---|---|---|
| 89 | planned | TestMatchPresenceList | `server/match_presence_test.go` | — |
| 90 | planned | TestEncode | `server/match_registry_test.go` | — |
| 91 | planned | TestEncodeDecode | `server/match_registry_test.go` | — |
| 92 | planned | TestEncodeDecodePresences | `server/match_registry_test.go` | — |
| 93 | planned | TestMatchRegistryAuthoritativeMatchAndJoin | `server/match_registry_test.go` | — |
| 94 | planned | TestMatchRegistryAuthoritativeMatchAndListAllMatchesWithQueryStar | `server/match_registry_test.go` | — |
| 95 | planned | TestMatchRegistryAuthoritativeMatchAndListMatches | `server/match_registry_test.go` | — |
| 96 | planned | TestMatchRegistryAuthoritativeMatchAndListMatchesWithQuerying | `server/match_registry_test.go` | — |
| 97 | planned | TestMatchRegistryAuthoritativeMatchAndListMatchesWithQueryingAndBoost | `server/match_registry_test.go` | — |
| 98 | planned | TestMatchRegistryAuthoritativeMatchAndListMatchesWithQueryingArrays | `server/match_registry_test.go` | — |
| 99 | planned | TestMatchRegistryAuthoritativeMatchAndListMatchesWithTokenizableLabel | `server/match_registry_test.go` | — |
| 100 | planned | TestMatchRegistryListMatchesAfterLabelsUpdate | `server/match_registry_test.go` | — |
| 101 | planned | TestGroupIndexes | `server/matchmaker_test.go` | — |
| 102 | planned | TestMatchmakerAddAndMatchAuthoritative | `server/matchmaker_test.go` | — |
| 103 | planned | TestMatchmakerAddAndRemove | `server/matchmaker_test.go` | — |
| 104 | planned | TestMatchmakerAddButNotMatch | `server/matchmaker_test.go` | — |
| 105 | planned | TestMatchmakerAddButNotMatchOnRange | `server/matchmaker_test.go` | — |
| 106 | planned | TestMatchmakerAddButNotMatchOnRangeAndValue | `server/matchmaker_test.go` | — |
| 107 | planned | TestMatchmakerAddMultipleAndSomeMatch | `server/matchmaker_test.go` | — |
| 108 | planned | TestMatchmakerAddMultipleAndSomeMatchOptionalTextAlteringScore | `server/matchmaker_test.go` | — |
| 109 | planned | TestMatchmakerAddMultipleAndSomeMatchWithBoost | `server/matchmaker_test.go` | — |
| 110 | planned | TestMatchmakerAddOnly | `server/matchmaker_test.go` | — |
| 111 | planned | TestMatchmakerAddRemoveNotMatch | `server/matchmaker_test.go` | — |
| 112 | planned | TestMatchmakerAddRemoveRepeated | `server/matchmaker_test.go` | — |
| 113 | planned | TestMatchmakerAddWithBasicMatch | `server/matchmaker_test.go` | — |
| 114 | planned | TestMatchmakerAddWithMatchOnRange | `server/matchmaker_test.go` | — |
| 115 | planned | TestMatchmakerAddWithMatchOnRangeAndValue | `server/matchmaker_test.go` | — |
| 116 | planned | TestMatchmakerAddWithMatchOnStar | `server/matchmaker_test.go` | — |
| 117 | planned | TestMatchmakerMaxPartyTracking | `server/matchmaker_test.go` | — |
| 118 | planned | TestMatchmakerMaxSessionTracking | `server/matchmaker_test.go` | — |
| 119 | planned | TestMatchmakerPropertyRegexSubmatch | `server/matchmaker_test.go` | — |
| 120 | planned | TestMatchmakerPropertyRegexSubmatchMultiple | `server/matchmaker_test.go` | — |
| 121 | planned | TestMatchmakerRequireMutualMatch | `server/matchmaker_test.go` | — |
| 122 | planned | TestMatchmakerRequireMutualMatchLarger | `server/matchmaker_test.go` | — |
| 123 | planned | TestMatchmakerRequireMutualMatchLargerReversed | `server/matchmaker_test.go` | — |

### M8 派对与运行时扩展

| # | 状态 | 上游测试 | 文件 | 证据 / 理由 |
|---:|---|---|---|---|
| 124 | planned | TestPartyMatchmakerAddAndRemove | `server/party_handler_test.go` | — |
| 125 | planned | TestGoLoggerDebug | `server/runtime_go_logger_test.go` | — |
| 126 | planned | TestGoLoggerError | `server/runtime_go_logger_test.go` | — |
| 127 | planned | TestGoLoggerFields | `server/runtime_go_logger_test.go` | — |
| 128 | planned | TestGoLoggerInfo | `server/runtime_go_logger_test.go` | — |
| 129 | planned | TestGoLoggerWarn | `server/runtime_go_logger_test.go` | — |
| 130 | planned | TestGoLoggerWithField | `server/runtime_go_logger_test.go` | — |
| 131 | planned | TestGoLoggerWithFields | `server/runtime_go_logger_test.go` | — |
| 132 | planned | TestJsLoggerDebug | `server/runtime_javascript_logger_test.go` | — |
| 133 | planned | TestJsLoggerError | `server/runtime_javascript_logger_test.go` | — |
| 134 | planned | TestJsLoggerInfo | `server/runtime_javascript_logger_test.go` | — |
| 135 | planned | TestJsLoggerWarn | `server/runtime_javascript_logger_test.go` | — |
| 136 | planned | TestJsLoggerWithField | `server/runtime_javascript_logger_test.go` | — |
| 137 | planned | TestJsLoggerWithFields | `server/runtime_javascript_logger_test.go` | — |
| 138 | planned | TestJsObjectFreeze | `server/runtime_javascript_test.go` | — |
| 139 | planned | TestRuntimeAes128 | `server/runtime_test.go` | — |
| 140 | planned | TestRuntimeBase16 | `server/runtime_test.go` | — |
| 141 | planned | TestRuntimeBase64 | `server/runtime_test.go` | — |
| 142 | planned | TestRuntimeBcryptCompare | `server/runtime_test.go` | — |
| 143 | planned | TestRuntimeBcryptHash | `server/runtime_test.go` | — |
| 144 | planned | TestRuntimeBit32 | `server/runtime_test.go` | — |
| 145 | planned | TestRuntimeDisallowStandardLibs | `server/runtime_test.go` | — |
| 146 | planned | TestRuntimeGroupTests | `server/runtime_test.go` | — |
| 147 | planned | TestRuntimeHTTPRequest | `server/runtime_test.go` | — |
| 148 | planned | TestRuntimeJson | `server/runtime_test.go` | — |
| 149 | planned | TestRuntimeMD5Hash | `server/runtime_test.go` | — |
| 150 | planned | TestRuntimeNotificationsDelete | `server/runtime_test.go` | — |
| 151 | planned | TestRuntimeNotificationSend | `server/runtime_test.go` | — |
| 152 | planned | TestRuntimeNotificationsSend | `server/runtime_test.go` | — |
| 153 | planned | TestRuntimeRegisterRPCWithPayload | `server/runtime_test.go` | — |
| 154 | planned | TestRuntimeRegisterRPCWithPayloadEndToEnd | `server/runtime_test.go` | — |
| 155 | planned | TestRuntimeReqAfterHook | `server/runtime_test.go` | — |
| 156 | planned | TestRuntimeReqBeforeHook | `server/runtime_test.go` | — |
| 157 | planned | TestRuntimeReqBeforeHookDisallowed | `server/runtime_test.go` | — |
| 158 | planned | TestRuntimeRequireEval | `server/runtime_test.go` | — |
| 159 | planned | TestRuntimeRequireFile | `server/runtime_test.go` | — |
| 160 | planned | TestRuntimeRequirePreload | `server/runtime_test.go` | — |
| 161 | planned | TestRuntimeRTBeforeHook | `server/runtime_test.go` | — |
| 162 | planned | TestRuntimeRTBeforeHookDisallow | `server/runtime_test.go` | — |
| 163 | planned | TestRuntimeSampleScript | `server/runtime_test.go` | — |
| 164 | planned | TestRuntimeSHA256Hash | `server/runtime_test.go` | — |
| 165 | planned | TestRuntimeStorageRead | `server/runtime_test.go` | — |
| 166 | planned | TestRuntimeStorageWrite | `server/runtime_test.go` | — |
| 167 | planned | TestRuntimeWalletWrite | `server/runtime_test.go` | — |

### M9 管理台与运维面

| # | 状态 | 上游测试 | 文件 | 证据 / 理由 |
|---:|---|---|---|---|
| 168 | planned | Test_Permission | `console/acl/acl_test.go` | — |
| 169 | planned | TestAddUserRejectsInvalidACLBeforeSideEffects | `server/console_user_add_acl_test.go` | — |
| 170 | planned | TestValidateConsoleUserACLGrant | `server/console_user_add_acl_test.go` | — |
| 171 | planned | TestResetUserPasswordAuthorizesTargetACLBeforeUpdate | `server/console_user_reset_password_acl_test.go` | — |
| 172 | planned | TestValidateConsoleUserTargetACL | `server/console_user_reset_password_acl_test.go` | — |

### MX 横切（配置/指标/关停/流管理）

| # | 状态 | 上游测试 | 文件 | 证据 / 理由 |
|---:|---|---|---|---|
| 173 | planned | TestGoogleAuthConfigCloneCopiesClientIDs | `server/config_test.go` | — |
| 174 | planned | TestParseArgsGoogleAuthClientIDs | `server/config_test.go` | — |
| 175 | planned | TestMetricsCounterAddNegativeDoesNotPanic | `server/metrics_test.go` | — |
| 176 | planned | TestServer_HandleShutdown | `server/shutdown_test.go` | — |

### LUA Lua 运行时（后置，不属于 v1~v4 的 P0/P1）

| # | 状态 | 上游测试 | 文件 | 证据 / 理由 |
|---:|---|---|---|---|
| 177 | planned | TestCheckBool | `internal/gopher-lua/auxlib_test.go` | — |
| 178 | planned | TestCheckChannel | `internal/gopher-lua/auxlib_test.go` | — |
| 179 | planned | TestCheckFunction | `internal/gopher-lua/auxlib_test.go` | — |
| 180 | planned | TestCheckInt | `internal/gopher-lua/auxlib_test.go` | — |
| 181 | planned | TestCheckInt64 | `internal/gopher-lua/auxlib_test.go` | — |
| 182 | planned | TestCheckNumber | `internal/gopher-lua/auxlib_test.go` | — |
| 183 | planned | TestCheckOption | `internal/gopher-lua/auxlib_test.go` | — |
| 184 | planned | TestCheckString | `internal/gopher-lua/auxlib_test.go` | — |
| 185 | planned | TestCheckTable | `internal/gopher-lua/auxlib_test.go` | — |
| 186 | planned | TestCheckThread | `internal/gopher-lua/auxlib_test.go` | — |
| 187 | planned | TestCheckType | `internal/gopher-lua/auxlib_test.go` | — |
| 188 | planned | TestCheckTypes | `internal/gopher-lua/auxlib_test.go` | — |
| 189 | planned | TestCheckUserData | `internal/gopher-lua/auxlib_test.go` | — |
| 190 | planned | TestLoadFileForEmptyFile | `internal/gopher-lua/auxlib_test.go` | — |
| 191 | planned | TestLoadFileForShebang | `internal/gopher-lua/auxlib_test.go` | — |
| 192 | planned | TestOptBool | `internal/gopher-lua/auxlib_test.go` | — |
| 193 | planned | TestOptChannel | `internal/gopher-lua/auxlib_test.go` | — |
| 194 | planned | TestOptFunction | `internal/gopher-lua/auxlib_test.go` | — |
| 195 | planned | TestOptInt | `internal/gopher-lua/auxlib_test.go` | — |
| 196 | planned | TestOptInt64 | `internal/gopher-lua/auxlib_test.go` | — |
| 197 | planned | TestOptNumber | `internal/gopher-lua/auxlib_test.go` | — |
| 198 | planned | TestOptString | `internal/gopher-lua/auxlib_test.go` | — |
| 199 | planned | TestOptTable | `internal/gopher-lua/auxlib_test.go` | — |
| 200 | planned | TestOptUserData | `internal/gopher-lua/auxlib_test.go` | — |
| 201 | planned | TestCancelChannelReceive | `internal/gopher-lua/channellib_test.go` | — |
| 202 | planned | TestCancelChannelReceive2 | `internal/gopher-lua/channellib_test.go` | — |
| 203 | planned | TestChannelMake | `internal/gopher-lua/channellib_test.go` | — |
| 204 | planned | TestChannelSelect1 | `internal/gopher-lua/channellib_test.go` | — |
| 205 | planned | TestChannelSelect2 | `internal/gopher-lua/channellib_test.go` | — |
| 206 | planned | TestChannelSelect3 | `internal/gopher-lua/channellib_test.go` | — |
| 207 | planned | TestChannelSelect4 | `internal/gopher-lua/channellib_test.go` | — |
| 208 | planned | TestChannelSelectError | `internal/gopher-lua/channellib_test.go` | — |
| 209 | planned | TestChannelSendReceive1 | `internal/gopher-lua/channellib_test.go` | — |
| 210 | planned | TestMathRandom | `internal/gopher-lua/mathlib_test.go` | — |
| 211 | planned | TestMathRandomConcurrencyRace | `internal/gopher-lua/mathlib_test.go` | — |
| 212 | planned | TestMathRandomSeeded | `internal/gopher-lua/mathlib_test.go` | — |
| 213 | planned | TestMathRandomUnseeded | `internal/gopher-lua/mathlib_test.go` | — |
| 214 | planned | TestGlua | `internal/gopher-lua/script_test.go` | — |
| 215 | planned | TestLocalVarFree | `internal/gopher-lua/script_test.go` | — |
| 216 | planned | TestLua | `internal/gopher-lua/script_test.go` | — |
| 217 | planned | TestCallStackOverflowWhenAutoGrow | `internal/gopher-lua/state_test.go` | — |
| 218 | planned | TestCallStackOverflowWhenFixed | `internal/gopher-lua/state_test.go` | — |
| 219 | planned | TestConcat | `internal/gopher-lua/state_test.go` | — |
| 220 | planned | TestContextCancel | `internal/gopher-lua/state_test.go` | — |
| 221 | planned | TestContextTimeout | `internal/gopher-lua/state_test.go` | — |
| 222 | planned | TestContextWithCroutine | `internal/gopher-lua/state_test.go` | — |
| 223 | planned | TestCoroutineApi1 | `internal/gopher-lua/state_test.go` | — |
| 224 | planned | TestGetAndReplace | `internal/gopher-lua/state_test.go` | — |
| 225 | planned | TestLStateIsClosed | `internal/gopher-lua/state_test.go` | — |
| 226 | planned | TestObjLen | `internal/gopher-lua/state_test.go` | — |
| 227 | planned | TestPCall | `internal/gopher-lua/state_test.go` | — |
| 228 | planned | TestPCallAfterFail | `internal/gopher-lua/state_test.go` | — |
| 229 | planned | TestRegistryAutoGrow | `internal/gopher-lua/state_test.go` | — |
| 230 | planned | TestRegistryFixedOverflow | `internal/gopher-lua/state_test.go` | — |
| 231 | planned | TestRemove | `internal/gopher-lua/state_test.go` | — |
| 232 | planned | TestSkipOpenLibs | `internal/gopher-lua/state_test.go` | — |
| 233 | planned | TestToChannel | `internal/gopher-lua/state_test.go` | — |
| 234 | planned | TestToFunction | `internal/gopher-lua/state_test.go` | — |
| 235 | planned | TestToInt | `internal/gopher-lua/state_test.go` | — |
| 236 | planned | TestToInt64 | `internal/gopher-lua/state_test.go` | — |
| 237 | planned | TestToNumber | `internal/gopher-lua/state_test.go` | — |
| 238 | planned | TestToString | `internal/gopher-lua/state_test.go` | — |
| 239 | planned | TestToTable | `internal/gopher-lua/state_test.go` | — |
| 240 | planned | TestToUserData | `internal/gopher-lua/state_test.go` | — |
| 241 | planned | TestUninitializedVarAccess | `internal/gopher-lua/state_test.go` | — |
| 242 | planned | TestTableAppend | `internal/gopher-lua/table_test.go` | — |
| 243 | planned | TestTableForEach | `internal/gopher-lua/table_test.go` | — |
| 244 | planned | TestTableInsert | `internal/gopher-lua/table_test.go` | — |
| 245 | planned | TestTableLen | `internal/gopher-lua/table_test.go` | — |
| 246 | planned | TestTableLenType | `internal/gopher-lua/table_test.go` | — |
| 247 | planned | TestTableMaxN | `internal/gopher-lua/table_test.go` | — |
| 248 | planned | TestTableNewLTable | `internal/gopher-lua/table_test.go` | — |
| 249 | planned | TestTableRawGetH | `internal/gopher-lua/table_test.go` | — |
| 250 | planned | TestTableRawSetH | `internal/gopher-lua/table_test.go` | — |
| 251 | planned | TestTableRawSetInt | `internal/gopher-lua/table_test.go` | — |
| 252 | planned | TestTableRemove | `internal/gopher-lua/table_test.go` | — |

### ALG 上游内部算法（本项目按自己的数据结构重写，只对齐可观测行为）

| # | 状态 | 上游测试 | 文件 | 证据 / 理由 |
|---:|---|---|---|---|
| 253 | planned | TestBackwardExpressions | `internal/cronexpr/cronexpr_test.go` | — |
| 254 | planned | TestExpressions | `internal/cronexpr/cronexpr_test.go` | — |
| 255 | planned | TestInterval_Interval60Issue | `internal/cronexpr/cronexpr_test.go` | — |
| 256 | planned | TestNextN | `internal/cronexpr/cronexpr_test.go` | — |
| 257 | planned | TestNextN_every5min | `internal/cronexpr/cronexpr_test.go` | — |
| 258 | planned | TestZero | `internal/cronexpr/cronexpr_test.go` | — |
| 259 | planned | TestSkiplistChaos | `internal/skiplist/skiplist_chaos_test.go` | — |
| 260 | planned | TestInt | `internal/skiplist/skiplist_test.go` | — |
| 261 | planned | TestRank | `internal/skiplist/skiplist_test.go` | — |

### NS 非目标（上游商业控制台的数据面）

| # | 状态 | 上游测试 | 文件 | 证据 / 理由 |
|---:|---|---|---|---|
| 262 | planned | TestSatoriClient_EventsPublish | `internal/satori/satori_test.go` | — |
| 263 | planned | TestSatoriClientMemory | `internal/satori/satori_test.go` | — |

## 第二证据源（自主契约测试引用到的上游非测试文件）

上游测试覆盖不到的地方（尤其是 REST/身份面与频道面），对齐必须靠这些引用：
每一条都是从上游实现/proto 定义里逐字推出来的契约，而不是拍脑袋写的期望值。

| 上游契约源 | 我们的测试 |
|---|---|
| `apigrpc/apigrpc.swagger.json::/healthcheck` | `tests/integration/healthcheck.test.ts` |
| `server/api.go::grpcGatewayRouter` | `tests/e2e/toolchain.e2e.test.ts`、`tests/integration/healthcheck.test.ts` |
| `server/api.go::handleRoutingError` | `tests/e2e/toolchain.e2e.test.ts`、`tests/integration/healthcheck.test.ts` |
| `vendor/github.com/grpc-ecosystem/grpc-gateway/v2/runtime/errors.go::DefaultHTTPErrorHandler` | `tests/integration/healthcheck.test.ts`、`tests/unit/grpc_status.test.ts` |
| `vendor/github.com/grpc-ecosystem/grpc-gateway/v2/runtime/errors.go::HTTPStatusFromCode` | `tests/e2e/toolchain.e2e.test.ts`、`tests/unit/grpc_status.test.ts` |
<!-- integrity: body_sha256=f2efca031770f5195e9400606bcee76a88b48fd093651281754488c307e3074d -->
