# 覆盖矩阵（脚本生成，请勿手改）

> **为什么它是一个整块**：本文件由 `npm run conformance:matrix` 整体重写，
> 价值全在“逐条去向与总数在同一张表里自洽”。拆成多份就没法只看一处判断有没有条目漏网，
> 所以按仓库约定（单文件 ≤300 行）作为生成物整体豁免拆分。

这份表回答一个问题：**上游测试套件里的每一条，在我们的项目里到底有着落没有。**

状态判定全部由脚本完成，不靠人填表：`ported` = 我们的测试里写了 `溯源:` 指向它；
`exempt` = 在 `docs/conformance/exemptions.json` 里且写了理由；其余一律 `planned`。
`planned` 不是失败，是**待办**；但它在任何声称已交付的里程碑范围内出现，就是断链。

| 项目 | 值 |
|---|---|
| 上游 commit | `e920249a3465bea4b8ea2968020c488201b61a8e` |
| 上游测试条目 | 263 |
| ported | 165 |
| planned | 96 |
| exempt | 2 |
| 无理由豁免 | 0 |
| 第二证据源引用（自主契约测试） | 138 |

## 按里程碑

| 里程碑 | 范围 | 条目 | ported | planned | exempt |
|---|---|---:|---:|---:|---:|
| M1 | 身份与账号 | 1 | 1 | 0 | 0 |
| M2 | 存储引擎 | 57 | 57 | 0 | 0 |
| M3 | 实时协议与在线状态 | 1 | 1 | 0 | 0 |
| M4 | 频道与聊天 | 0 | 0 | 0 | 0 |
| M5 | 社交（好友/群组/通知/社交登录令牌校验） | 4 | 4 | 0 | 0 |
| M6 | 经济与竞技（钱包/排行榜/锦标赛） | 25 | 24 | 0 | 1 |
| M7 | 匹配与对局 | 35 | 35 | 0 | 0 |
| M8 | 派对与运行时扩展 | 44 | 43 | 0 | 1 |
| M9 | 管理台与运维面 | 5 | 0 | 5 | 0 |
| MX | 横切（配置/指标/关停/流管理） | 4 | 0 | 4 | 0 |
| LUA | Lua 运行时（后置，不属于 v1~v4 的 P0/P1） | 76 | 0 | 76 | 0 |
| ALG | 上游内部算法（本项目按自己的数据结构重写，只对齐可观测行为） | 9 | 0 | 9 | 0 |
| NS | 非目标（上游商业控制台的数据面） | 2 | 0 | 2 | 0 |

## 逐条清单

### M1 身份与账号

| # | 状态 | 上游测试 | 文件 | 证据 / 理由 |
|---:|---|---|---|---|
| 1 | ported | TestWWWAuthenticateHeaderOnUnauthenticated | `server/api_test.go` | `tests/integration/identity/base-and-auth-server.test.ts` |

### M2 存储引擎

| # | 状态 | 上游测试 | 文件 | 证据 / 理由 |
|---:|---|---|---|---|
| 2 | ported | TestNonOCCAuthoritative | `server/core_storage_test.go` | `tests/integration/storage/version-matrix.test.ts` |
| 3 | ported | TestNonOCCNonAuthoritative | `server/core_storage_test.go` | `tests/integration/storage/version-matrix.test.ts` |
| 4 | ported | TestOCCNotExistsAuthoritative | `server/core_storage_test.go` | `tests/integration/storage/version-matrix.test.ts` |
| 5 | ported | TestOCCNotExistsNonAuthoritative | `server/core_storage_test.go` | `tests/integration/storage/version-matrix.test.ts` |
| 6 | ported | TestOCCWriteAuthoritative | `server/core_storage_test.go` | `tests/integration/storage/version-matrix.test.ts` |
| 7 | ported | TestOCCWriteNonAuthoritative | `server/core_storage_test.go` | `tests/integration/storage/version-matrix.test.ts` |
| 8 | ported | TestOCCWriteSameValueCorrectVersionSuccess | `server/core_storage_test.go` | `tests/integration/storage/version-matrix.test.ts` |
| 9 | ported | TestOCCWriteSameValueWithOutdatedVersionFail | `server/core_storage_test.go` | `tests/integration/storage/version-matrix.test.ts` |
| 10 | ported | TestStorageFetchPipelineGlobalPrivate | `server/core_storage_test.go` | `tests/integration/storage/fetch.test.ts` |
| 11 | ported | TestStorageFetchPipelineUserOtherPublic | `server/core_storage_test.go` | `tests/integration/storage/fetch.test.ts` |
| 12 | ported | TestStorageFetchPipelineUserOtherPublicMixed | `server/core_storage_test.go` | `tests/integration/storage/fetch.test.ts` |
| 13 | ported | TestStorageFetchPipelineUserOtherRead | `server/core_storage_test.go` | `tests/integration/storage/fetch.test.ts` |
| 14 | ported | TestStorageFetchPipelineUserPrivate | `server/core_storage_test.go` | `tests/integration/storage/fetch.test.ts` |
| 15 | ported | TestStorageFetchPipelineUserPublic | `server/core_storage_test.go` | `tests/integration/storage/fetch.test.ts` |
| 16 | ported | TestStorageFetchPipelineUserRead | `server/core_storage_test.go` | `tests/integration/storage/fetch.test.ts` |
| 17 | ported | TestStorageFetchRuntimeGlobalPrivate | `server/core_storage_test.go` | `tests/integration/storage/fetch.test.ts` |
| 18 | ported | TestStorageFetchRuntimeMixed | `server/core_storage_test.go` | `tests/integration/storage/fetch.test.ts` |
| 19 | ported | TestStorageFetchRuntimeUserPrivate | `server/core_storage_test.go` | `tests/integration/storage/fetch.test.ts` |
| 20 | ported | TestStorageListNoRepeats | `server/core_storage_test.go` | `tests/integration/storage/list.test.ts` |
| 21 | ported | TestStorageListPipelineUserOther | `server/core_storage_test.go` | `tests/integration/storage/list.test.ts` |
| 22 | ported | TestStorageListPipelineUserSelf | `server/core_storage_test.go` | `tests/integration/storage/list.test.ts` |
| 23 | ported | TestStorageListRuntimeUser | `server/core_storage_test.go` | `tests/integration/storage/list.test.ts` |
| 24 | ported | TestStorageOverrwriteEmptyAndNonEmptyVersions | `server/core_storage_test.go` | `tests/integration/storage/version-overwrite.test.ts` |
| 25 | ported | TestStorageReadObjectsAllDistinctArgs | `server/core_storage_test.go` | `tests/integration/storage/read-multi.test.ts` |
| 26 | ported | TestStorageReadObjectsOneDistinctArg | `server/core_storage_test.go` | `tests/integration/storage/read-multi.test.ts` |
| 27 | ported | TestStorageReadObjectsSameArgs | `server/core_storage_test.go` | `tests/integration/storage/read-multi.test.ts` |
| 28 | ported | TestStorageReadObjectsTwoDistinctArgs | `server/core_storage_test.go` | `tests/integration/storage/read-multi.test.ts` |
| 29 | ported | TestStorageRemovePipelineUserDenied | `server/core_storage_test.go` | `tests/integration/storage/delete.test.ts` |
| 30 | ported | TestStorageRemovePipelineUserWrite | `server/core_storage_test.go` | `tests/integration/storage/delete.test.ts` |
| 31 | ported | TestStorageRemoveRuntimeGlobalIfMatch | `server/core_storage_test.go` | `tests/integration/storage/delete.test.ts` |
| 32 | ported | TestStorageRemoveRuntimeGlobalIfMatchNotExists | `server/core_storage_test.go` | `tests/integration/storage/delete.test.ts` |
| 33 | ported | TestStorageRemoveRuntimeGlobalIfMatchRejected | `server/core_storage_test.go` | `tests/integration/storage/delete.test.ts` |
| 34 | ported | TestStorageRemoveRuntimeGlobalPrivate | `server/core_storage_test.go` | `tests/integration/storage/delete.test.ts` |
| 35 | ported | TestStorageRemoveRuntimeGlobalPublic | `server/core_storage_test.go` | `tests/integration/storage/delete.test.ts` |
| 36 | ported | TestStorageRemoveRuntimeUserPrivate | `server/core_storage_test.go` | `tests/integration/storage/delete.test.ts` |
| 37 | ported | TestStorageRemoveRuntimeUserPublic | `server/core_storage_test.go` | `tests/integration/storage/delete.test.ts` |
| 38 | ported | TestStorageWritePipelineIfMatchExists | `server/core_storage_test.go` | `tests/integration/storage/write-pipeline.test.ts` |
| 39 | ported | TestStorageWritePipelineIfMatchExistsFail | `server/core_storage_test.go` | `tests/integration/storage/write-pipeline.test.ts` |
| 40 | ported | TestStorageWritePipelineIfMatchNotExists | `server/core_storage_test.go` | `tests/integration/storage/write-pipeline.test.ts` |
| 41 | ported | TestStorageWritePipelineIfNoneMatchExists | `server/core_storage_test.go` | `tests/integration/storage/write-pipeline.test.ts` |
| 42 | ported | TestStorageWritePipelineIfNoneMatchNotExists | `server/core_storage_test.go` | `tests/integration/storage/write-pipeline.test.ts` |
| 43 | ported | TestStorageWritePipelinePermissionFail | `server/core_storage_test.go` | `tests/integration/storage/write-pipeline.test.ts` |
| 44 | ported | TestStorageWritePipelineUserMultiple | `server/core_storage_test.go` | `tests/integration/storage/write-pipeline.test.ts` |
| 45 | ported | TestStorageWritePipelineUserMultipleSameKey | `server/core_storage_test.go` | `tests/integration/storage/write-pipeline.test.ts` |
| 46 | ported | TestStorageWritePipelineUserSingle | `server/core_storage_test.go` | `tests/integration/storage/write-pipeline.test.ts` |
| 47 | ported | TestStorageWriteRuntimeGlobalMultipleIfMatchNotExists | `server/core_storage_test.go` | `tests/integration/storage/write-runtime.test.ts` |
| 48 | ported | TestStorageWriteRuntimeGlobalMultipleSameKey | `server/core_storage_test.go` | `tests/integration/storage/write-runtime.test.ts` |
| 49 | ported | TestStorageWriteRuntimeGlobalSingle | `server/core_storage_test.go` | `tests/integration/storage/write-runtime.test.ts` |
| 50 | ported | TestStorageWriteRuntimeGlobalSingleIfMatchExists | `server/core_storage_test.go` | `tests/integration/storage/write-runtime.test.ts` |
| 51 | ported | TestStorageWriteRuntimeGlobalSingleIfMatchExistsFail | `server/core_storage_test.go` | `tests/integration/storage/write-runtime.test.ts` |
| 52 | ported | TestStorageWriteRuntimeGlobalSingleIfMatchNotExists | `server/core_storage_test.go` | `tests/integration/storage/write-runtime.test.ts` |
| 53 | ported | TestStorageWriteRuntimeGlobalSingleIfNoneMatchExists | `server/core_storage_test.go` | `tests/integration/storage/write-runtime.test.ts` |
| 54 | ported | TestStorageWriteRuntimeGlobalSingleIfNoneMatchNotExists | `server/core_storage_test.go` | `tests/integration/storage/write-runtime.test.ts` |
| 55 | ported | TestStorageWriteRuntimeUserMultiple | `server/core_storage_test.go` | `tests/integration/storage/write-runtime.test.ts` |
| 56 | ported | TestLocalStorageIndex_Delete | `server/storage_index_test.go` | `tests/integration/storage/index-list.test.ts` |
| 57 | ported | TestLocalStorageIndex_List | `server/storage_index_test.go` | `tests/integration/storage/index-list.test.ts` |
| 58 | ported | TestLocalStorageIndex_Write | `server/storage_index_test.go` | `tests/integration/storage/index-write.test.ts` |

### M3 实时协议与在线状态

| # | 状态 | 上游测试 | 文件 | 证据 / 理由 |
|---:|---|---|---|---|
| 59 | ported | TestWebSocketRejectsSessionAfterLogout | `server/socket_ws_test.go` | `tests/integration/realtime/handshake.test.ts` |

### M5 社交（好友/群组/通知/社交登录令牌校验）

| # | 状态 | 上游测试 | 文件 | 证据 / 理由 |
|---:|---|---|---|---|
| 60 | ported | TestServer_ListFriendsOfFriends | `server/core_friend_test.go` | `tests/integration/friends/friends-of-friends.test.ts` |
| 61 | ported | TestCheckGoogleTokenDoesNotExchangeMalformedJWT | `social/google_token_audience_test.go` | `tests/integration/social/google-auth-code.test.ts` |
| 62 | ported | TestCheckGoogleTokenPreservesAuthorizationCodeFlow | `social/google_token_audience_test.go` | `tests/integration/social/google-auth-code.test.ts` |
| 63 | ported | TestCheckGoogleTokenValidatesAudience | `social/google_token_audience_test.go` | `tests/integration/social/google-token.test.ts` |

### M6 经济与竞技（钱包/排行榜/锦标赛）

| # | 状态 | 上游测试 | 文件 | 证据 / 理由 |
|---:|---|---|---|---|
| 64 | ported | TestApiLeaderboard | `server/api_leaderboard_test.go` | `tests/integration/competitive/leaderboard-haystack.test.ts`、`tests/integration/competitive/leaderboard.test.ts` |
| 65 | ported | TestApiTournamentHaystack | `server/api_tournament_test.go` | `tests/integration/competitive/tournament.test.ts` |
| 66 | ported | TestTournamentEveryDayMonThruFri | `server/core_tournament_test.go` | `tests/unit/competitive/tournament-deadlines.test.ts` |
| 67 | ported | TestTournamentEveryFourteenDaysFromFirst | `server/core_tournament_test.go` | `tests/unit/competitive/tournament-deadlines.test.ts` |
| 68 | ported | TestTournamentNowIsBeforeStart | `server/core_tournament_test.go` | `tests/unit/competitive/tournament-deadlines.test.ts` |
| 69 | ported | TestTournamentNowIsResetTime | `server/core_tournament_test.go` | `tests/unit/competitive/tournament-deadlines.test.ts` |
| 70 | ported | TestUpdateWalletMultiUser | `server/core_wallet_test.go` | `tests/integration/competitive/wallet.test.ts` |
| 71 | ported | TestUpdateWalletRepeatedSingleUser | `server/core_wallet_test.go` | `tests/integration/competitive/wallet.test.ts` |
| 72 | ported | TestUpdateWalletSingleUser | `server/core_wallet_test.go` | `tests/integration/competitive/wallet.test.ts` |
| 73 | ported | TestUpdateWalletsMultiUser | `server/core_wallet_test.go` | `tests/integration/competitive/wallet.test.ts` |
| 74 | ported | TestUpdateWalletsMultiUserSharedChangeset | `server/core_wallet_test.go` | `tests/integration/competitive/wallet.test.ts` |
| 75 | ported | TestUpdateWalletsMultiUserSharedChangesetDeductions | `server/core_wallet_test.go` | `tests/integration/competitive/wallet.test.ts` |
| 76 | ported | TestUpdateWalletsSingleUser | `server/core_wallet_test.go` | `tests/integration/competitive/wallet.test.ts` |
| 77 | ported | TestLocalLeaderboardRankCache_Delete | `server/leaderboard_rank_cache_test.go` | `tests/unit/competitive/rank-cache-mutate.test.ts` |
| 78 | ported | TestLocalLeaderboardRankCache_DeleteLeaderboard | `server/leaderboard_rank_cache_test.go` | `tests/unit/competitive/rank-cache-mutate.test.ts` |
| 79 | ported | TestLocalLeaderboardRankCache_ExpirySeparation | `server/leaderboard_rank_cache_test.go` | `tests/unit/competitive/rank-cache-lifecycle.test.ts` |
| 80 | ported | TestLocalLeaderboardRankCache_Fill | `server/leaderboard_rank_cache_test.go` | `tests/unit/competitive/rank-cache-mutate.test.ts` |
| 81 | ported | TestLocalLeaderboardRankCache_Insert_Ascending | `server/leaderboard_rank_cache_test.go` | `tests/unit/competitive/rank-cache-insert.test.ts` |
| 82 | ported | TestLocalLeaderboardRankCache_Insert_Descending | `server/leaderboard_rank_cache_test.go` | `tests/unit/competitive/rank-cache-insert.test.ts` |
| 83 | ported | TestLocalLeaderboardRankCache_Insert_Existing | `server/leaderboard_rank_cache_test.go` | `tests/unit/competitive/rank-cache-insert.test.ts` |
| 84 | ported | TestLocalLeaderboardRankCache_LeaderboardSeparation | `server/leaderboard_rank_cache_test.go` | `tests/unit/competitive/rank-cache-lifecycle.test.ts` |
| 85 | ported | TestLocalLeaderboardRankCache_TrimExpired | `server/leaderboard_rank_cache_test.go` | `tests/unit/competitive/rank-cache-lifecycle.test.ts` |
| 86 | exempt | TestLeaderboardScheduler | `server/leaderboard_scheduler_test.go` | 上游自己把它 skip 了：正文第一行是 t.Skip("auxiliary test for scheduling logic, but too finicky to be part of the test suite")，函数体没有被任何 CI 执行过。它测的是「后台调度器连续跑几轮之后哪些期数该被清掉」这一段内部时序，属于上游 Go 实现的内部细节，不构成对外可观测契约。同一文件里真正有断言的另外两条（EndedTournamentHidesLiveExpiry / HidesSuccessorExpiry）已逐条搬运到 tests/unit/competitive/leaderboard-scheduler.test.ts，而调度重算本身由 computeNext 的单元用例覆盖。 |
| 87 | ported | TestLeaderboardSchedulerEndedTournamentHidesLiveExpiry | `server/leaderboard_scheduler_test.go` | `tests/unit/competitive/leaderboard-scheduler.test.ts` |
| 88 | ported | TestLeaderboardSchedulerEndedTournamentHidesSuccessorExpiry | `server/leaderboard_scheduler_test.go` | `tests/unit/competitive/leaderboard-scheduler.test.ts` |

### M7 匹配与对局

| # | 状态 | 上游测试 | 文件 | 证据 / 理由 |
|---:|---|---|---|---|
| 89 | ported | TestMatchPresenceList | `server/match_presence_test.go` | `tests/unit/match/presence.test.ts` |
| 90 | ported | TestEncode | `server/match_registry_test.go` | `tests/integration/match/roundtrip.test.ts` |
| 91 | ported | TestEncodeDecode | `server/match_registry_test.go` | `tests/integration/match/roundtrip.test.ts` |
| 92 | ported | TestEncodeDecodePresences | `server/match_registry_test.go` | `tests/integration/match/roundtrip.test.ts` |
| 93 | ported | TestMatchRegistryAuthoritativeMatchAndJoin | `server/match_registry_test.go` | `tests/integration/match/registry.test.ts` |
| 94 | ported | TestMatchRegistryAuthoritativeMatchAndListAllMatchesWithQueryStar | `server/match_registry_test.go` | `tests/integration/match/registry.test.ts` |
| 95 | ported | TestMatchRegistryAuthoritativeMatchAndListMatches | `server/match_registry_test.go` | `tests/integration/match/registry.test.ts` |
| 96 | ported | TestMatchRegistryAuthoritativeMatchAndListMatchesWithQuerying | `server/match_registry_test.go` | `tests/integration/match/registry.test.ts` |
| 97 | ported | TestMatchRegistryAuthoritativeMatchAndListMatchesWithQueryingAndBoost | `server/match_registry_test.go` | `tests/unit/matchmaker/pool.test.ts` |
| 98 | ported | TestMatchRegistryAuthoritativeMatchAndListMatchesWithQueryingArrays | `server/match_registry_test.go` | `tests/integration/match/registry.test.ts` |
| 99 | ported | TestMatchRegistryAuthoritativeMatchAndListMatchesWithTokenizableLabel | `server/match_registry_test.go` | `tests/integration/match/registry.test.ts` |
| 100 | ported | TestMatchRegistryListMatchesAfterLabelsUpdate | `server/match_registry_test.go` | `tests/integration/match/registry.test.ts` |
| 101 | ported | TestGroupIndexes | `server/matchmaker_test.go` | `tests/unit/matchmaker/matching.test.ts` |
| 102 | ported | TestMatchmakerAddAndMatchAuthoritative | `server/matchmaker_test.go` | `tests/integration/matchmaker/rounds.test.ts` |
| 103 | ported | TestMatchmakerAddAndRemove | `server/matchmaker_test.go` | `tests/integration/matchmaker/pipeline.test.ts`、`tests/unit/matchmaker/matching.test.ts` |
| 104 | ported | TestMatchmakerAddButNotMatch | `server/matchmaker_test.go` | `tests/unit/matchmaker/matching.test.ts` |
| 105 | ported | TestMatchmakerAddButNotMatchOnRange | `server/matchmaker_test.go` | `tests/unit/matchmaker/matching.test.ts` |
| 106 | ported | TestMatchmakerAddButNotMatchOnRangeAndValue | `server/matchmaker_test.go` | `tests/unit/matchmaker/matching.test.ts` |
| 107 | ported | TestMatchmakerAddMultipleAndSomeMatch | `server/matchmaker_test.go` | `tests/unit/matchmaker/matching.test.ts` |
| 108 | ported | TestMatchmakerAddMultipleAndSomeMatchOptionalTextAlteringScore | `server/matchmaker_test.go` | `tests/unit/matchmaker/matching.test.ts` |
| 109 | ported | TestMatchmakerAddMultipleAndSomeMatchWithBoost | `server/matchmaker_test.go` | `tests/unit/matchmaker/matching.test.ts` |
| 110 | ported | TestMatchmakerAddOnly | `server/matchmaker_test.go` | `tests/unit/matchmaker/pool.test.ts` |
| 111 | ported | TestMatchmakerAddRemoveNotMatch | `server/matchmaker_test.go` | `tests/unit/matchmaker/matching.test.ts` |
| 112 | ported | TestMatchmakerAddRemoveRepeated | `server/matchmaker_test.go` | `tests/integration/matchmaker/pipeline.test.ts`、`tests/unit/matchmaker/pool.test.ts` |
| 113 | ported | TestMatchmakerAddWithBasicMatch | `server/matchmaker_test.go` | `tests/unit/matchmaker/matching.test.ts` |
| 114 | ported | TestMatchmakerAddWithMatchOnRange | `server/matchmaker_test.go` | `tests/unit/matchmaker/matching.test.ts` |
| 115 | ported | TestMatchmakerAddWithMatchOnRangeAndValue | `server/matchmaker_test.go` | `tests/unit/matchmaker/matching.test.ts` |
| 116 | ported | TestMatchmakerAddWithMatchOnStar | `server/matchmaker_test.go` | `tests/unit/matchmaker/matching.test.ts` |
| 117 | ported | TestMatchmakerMaxPartyTracking | `server/matchmaker_test.go` | `tests/unit/matchmaker/tracking.test.ts` |
| 118 | ported | TestMatchmakerMaxSessionTracking | `server/matchmaker_test.go` | `tests/integration/matchmaker/rounds.test.ts` |
| 119 | ported | TestMatchmakerPropertyRegexSubmatch | `server/matchmaker_test.go` | `tests/unit/matchmaker/pool.test.ts` |
| 120 | ported | TestMatchmakerPropertyRegexSubmatchMultiple | `server/matchmaker_test.go` | `tests/unit/matchmaker/pool.test.ts` |
| 121 | ported | TestMatchmakerRequireMutualMatch | `server/matchmaker_test.go` | `tests/unit/matchmaker/matching.test.ts` |
| 122 | ported | TestMatchmakerRequireMutualMatchLarger | `server/matchmaker_test.go` | `tests/unit/matchmaker/matching.test.ts` |
| 123 | ported | TestMatchmakerRequireMutualMatchLargerReversed | `server/matchmaker_test.go` | `tests/unit/matchmaker/matching.test.ts` |

### M8 派对与运行时扩展

| # | 状态 | 上游测试 | 文件 | 证据 / 理由 |
|---:|---|---|---|---|
| 124 | ported | TestPartyMatchmakerAddAndRemove | `server/party_handler_test.go` | `tests/integration/party/frames.test.ts`、`tests/integration/party/lifecycle.test.ts`、`tests/unit/party/members.test.ts` |
| 125 | ported | TestGoLoggerDebug | `server/runtime_go_logger_test.go` | `tests/unit/runtime/log.test.ts` |
| 126 | ported | TestGoLoggerError | `server/runtime_go_logger_test.go` | `tests/unit/runtime/log.test.ts` |
| 127 | ported | TestGoLoggerFields | `server/runtime_go_logger_test.go` | `tests/unit/runtime/log.test.ts` |
| 128 | ported | TestGoLoggerInfo | `server/runtime_go_logger_test.go` | `tests/unit/runtime/log.test.ts` |
| 129 | ported | TestGoLoggerWarn | `server/runtime_go_logger_test.go` | `tests/unit/runtime/log.test.ts` |
| 130 | ported | TestGoLoggerWithField | `server/runtime_go_logger_test.go` | `tests/unit/runtime/log.test.ts` |
| 131 | ported | TestGoLoggerWithFields | `server/runtime_go_logger_test.go` | `tests/unit/runtime/log.test.ts` |
| 132 | ported | TestJsLoggerDebug | `server/runtime_javascript_logger_test.go` | `tests/unit/runtime/js-logger.test.ts` |
| 133 | ported | TestJsLoggerError | `server/runtime_javascript_logger_test.go` | `tests/unit/runtime/js-logger.test.ts` |
| 134 | ported | TestJsLoggerInfo | `server/runtime_javascript_logger_test.go` | `tests/unit/runtime/js-logger.test.ts` |
| 135 | ported | TestJsLoggerWarn | `server/runtime_javascript_logger_test.go` | `tests/unit/runtime/js-logger.test.ts` |
| 136 | ported | TestJsLoggerWithField | `server/runtime_javascript_logger_test.go` | `tests/unit/runtime/js-logger.test.ts` |
| 137 | ported | TestJsLoggerWithFields | `server/runtime_javascript_logger_test.go` | `tests/unit/runtime/js-logger.test.ts` |
| 138 | ported | TestJsObjectFreeze | `server/runtime_javascript_test.go` | `tests/unit/runtime/freeze.test.ts` |
| 139 | ported | TestRuntimeAes128 | `server/runtime_test.go` | `tests/unit/runtime/crypto.test.ts` |
| 140 | ported | TestRuntimeBase16 | `server/runtime_test.go` | `tests/unit/runtime/crypto.test.ts` |
| 141 | ported | TestRuntimeBase64 | `server/runtime_test.go` | `tests/unit/runtime/crypto.test.ts` |
| 142 | ported | TestRuntimeBcryptCompare | `server/runtime_test.go` | `tests/unit/runtime/crypto.test.ts` |
| 143 | ported | TestRuntimeBcryptHash | `server/runtime_test.go` | `tests/unit/runtime/crypto.test.ts` |
| 144 | ported | TestRuntimeBit32 | `server/runtime_test.go` | `tests/unit/runtime/bit32.test.ts` |
| 145 | ported | TestRuntimeDisallowStandardLibs | `server/runtime_test.go` | `tests/integration/runtime/modules.test.ts` |
| 146 | ported | TestRuntimeGroupTests | `server/runtime_test.go` | `tests/integration/runtime/tools.test.ts` |
| 147 | exempt | TestRuntimeHTTPRequest | `server/runtime_test.go` | 这条测的是 nk.httpRequest（Lua 的 nakama.http_request）能出网并拿回状态码。本项目走的是**刻意不同的实现路线**（ECN-0012 的出口策略段）：租户模块一律不得自行出网（装载时 globalOutbound: null），出网必须由宿主代发，而宿主代发面在 M8 的验收口径（REQ-0001-020）里不存在。等价的自主测试是 tests/integration/runtime/modules.test.ts::test_a_module_cannot_reach_the_host：它正向断言模块内的 fetch 被拒、宿主文件读不到、require 不存在。也就是说「这条能力不存在」是有证据的登记事实，与 ECN-0012 偏差 11（未实现的 nk.* 不存在，调用抛 TypeError）同一条规则；对外可观测行为的差异已在该 ECN 里登记，不是漏做。 |
| 148 | ported | TestRuntimeJson | `server/runtime_test.go` | `tests/unit/runtime/json.test.ts` |
| 149 | ported | TestRuntimeMD5Hash | `server/runtime_test.go` | `tests/unit/runtime/crypto.test.ts` |
| 150 | ported | TestRuntimeNotificationsDelete | `server/runtime_test.go` | `tests/integration/runtime/tools.test.ts` |
| 151 | ported | TestRuntimeNotificationSend | `server/runtime_test.go` | `tests/integration/runtime/tools.test.ts` |
| 152 | ported | TestRuntimeNotificationsSend | `server/runtime_test.go` | `tests/integration/runtime/tools.test.ts` |
| 153 | ported | TestRuntimeRegisterRPCWithPayload | `server/runtime_test.go` | `tests/integration/runtime/rpc.test.ts` |
| 154 | ported | TestRuntimeRegisterRPCWithPayloadEndToEnd | `server/runtime_test.go` | `tests/integration/runtime/rpc.test.ts` |
| 155 | ported | TestRuntimeReqAfterHook | `server/runtime_test.go` | `tests/integration/runtime/hooks.test.ts` |
| 156 | ported | TestRuntimeReqBeforeHook | `server/runtime_test.go` | `tests/integration/runtime/hooks.test.ts` |
| 157 | ported | TestRuntimeReqBeforeHookDisallowed | `server/runtime_test.go` | `tests/integration/runtime/hooks.test.ts` |
| 158 | ported | TestRuntimeRequireEval | `server/runtime_test.go` | `tests/integration/runtime/modules.test.ts` |
| 159 | ported | TestRuntimeRequireFile | `server/runtime_test.go` | `tests/integration/runtime/modules.test.ts` |
| 160 | ported | TestRuntimeRequirePreload | `server/runtime_test.go` | `tests/integration/runtime/modules.test.ts` |
| 161 | ported | TestRuntimeRTBeforeHook | `server/runtime_test.go` | `tests/integration/runtime/hooks.test.ts` |
| 162 | ported | TestRuntimeRTBeforeHookDisallow | `server/runtime_test.go` | `tests/integration/runtime/hooks.test.ts` |
| 163 | ported | TestRuntimeSampleScript | `server/runtime_test.go` | `tests/integration/runtime/modules.test.ts` |
| 164 | ported | TestRuntimeSHA256Hash | `server/runtime_test.go` | `tests/unit/runtime/crypto.test.ts` |
| 165 | ported | TestRuntimeStorageRead | `server/runtime_test.go` | `tests/integration/runtime/tools.test.ts` |
| 166 | ported | TestRuntimeStorageWrite | `server/runtime_test.go` | `tests/integration/runtime/tools.test.ts` |
| 167 | ported | TestRuntimeWalletWrite | `server/runtime_test.go` | `tests/integration/runtime/tools.test.ts` |

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
| `apigrpc/apigrpc.swagger.json::/v2/account/authenticate/device` | `tests/helpers/identity-fixtures.ts` |
| `apigrpc/apigrpc.swagger.json::/v2/account/authenticate/google` | `tests/integration/social/google-endpoint.test.ts` |
| `apigrpc/apigrpc.swagger.json::/v2/channel/{channelId}` | `tests/e2e/realtime-chat.e2e.test.ts`、`tests/integration/channel/history.test.ts` |
| `apigrpc/apigrpc.swagger.json::/v2/friend` | `tests/e2e/social.e2e.test.ts` |
| `apigrpc/apigrpc.swagger.json::/v2/group` | `tests/e2e/social.e2e.test.ts` |
| `apigrpc/apigrpc.swagger.json::/v2/leaderboard/{leaderboardId}` | `tests/e2e/competitive.e2e.test.ts` |
| `apigrpc/apigrpc.swagger.json::/v2/match` | `tests/e2e/match.e2e.test.ts` |
| `apigrpc/apigrpc.swagger.json::/v2/notification` | `tests/e2e/social.e2e.test.ts` |
| `apigrpc/apigrpc.swagger.json::/v2/tournament` | `tests/e2e/competitive.e2e.test.ts`、`tests/integration/competitive/tournament-endpoints.test.ts` |
| `server/api_account.go::GetAccount` | `tests/e2e/identity.e2e.test.ts`、`tests/helpers/identity-fixtures.ts` |
| `server/api_account.go::UpdateAccount` | `tests/e2e/identity.e2e.test.ts`、`tests/helpers/identity-fixtures.ts` |
| `server/api_authenticate.go::AuthenticateCustom` | `tests/helpers/identity-fixtures.ts` |
| `server/api_authenticate.go::AuthenticateDevice` | `tests/e2e/identity.e2e.test.ts`、`tests/e2e/tenancy.e2e.test.ts`、`tests/helpers/identity-fixtures.ts`、`tests/integration/tenancy.test.ts` |
| `server/api_authenticate.go::AuthenticateEmail` | `tests/helpers/identity-fixtures.ts` |
| `server/api_authenticate.go::AuthenticateGoogle` | `tests/integration/social/google-authenticate.test.ts`、`tests/integration/social/google-endpoint.test.ts` |
| `server/api_authenticate.go::generateRefreshToken` | `tests/unit/tenancy_keys.test.ts` |
| `server/api_channel.go::ListChannelMessages` | `tests/integration/channel/history.test.ts` |
| `server/api_friend.go::AddFriends` | `tests/e2e/social.e2e.test.ts`、`tests/integration/friends/relations.test.ts` |
| `server/api_friend.go::BlockFriends` | `tests/integration/friends/delete-block.test.ts` |
| `server/api_friend.go::DeleteFriends` | `tests/integration/friends/delete-block.test.ts` |
| `server/api_friend.go::ListFriends` | `tests/integration/friends/list.test.ts` |
| `server/api_group.go::CreateGroup` | `tests/e2e/social.e2e.test.ts`、`tests/integration/groups/lifecycle.test.ts` |
| `server/api_group.go::DeleteGroup` | `tests/integration/groups/lifecycle.test.ts` |
| `server/api_group.go::JoinGroup` | `tests/integration/groups/join.test.ts` |
| `server/api_group.go::ListGroups` | `tests/integration/groups/listing-groups.test.ts` |
| `server/api_group.go::ListGroupUsers` | `tests/integration/groups/listing-members.test.ts` |
| `server/api_group.go::ListUserGroups` | `tests/integration/groups/listing-members.test.ts` |
| `server/api_group.go::UpdateGroup` | `tests/integration/groups/lifecycle.test.ts` |
| `server/api_leaderboard.go::ListLeaderboardRecords` | `tests/e2e/competitive.e2e.test.ts` |
| `server/api_match.go::ApiServer.ListMatches` | `tests/integration/match/rest.test.ts` |
| `server/api_matchmaker.go::ApiServer.GetMatchmakerStats` | `tests/integration/match/rest.test.ts` |
| `server/api_notification.go::DeleteNotifications` | `tests/integration/notifications/delete.test.ts` |
| `server/api_notification.go::ListNotifications` | `tests/e2e/social.e2e.test.ts`、`tests/integration/notifications/list.test.ts` |
| `server/api_party.go::ApiServer.ListParties` | `tests/integration/party/listing.test.ts` |
| `server/api_session.go::SessionLogout` | `tests/e2e/identity.e2e.test.ts`、`tests/helpers/identity-fixtures.ts` |
| `server/api_session.go::SessionRefresh` | `tests/e2e/identity.e2e.test.ts`、`tests/helpers/identity-fixtures.ts` |
| `server/api_tournament.go::JoinTournament` | `tests/integration/competitive/tournament-endpoints.test.ts` |
| `server/api_tournament.go::ListTournaments` | `tests/e2e/competitive.e2e.test.ts`、`tests/integration/competitive/tournament-endpoints.test.ts` |
| `server/api_tournament.go::WriteTournamentRecord` | `tests/integration/competitive/tournament-endpoints.test.ts` |
| `server/api_user.go::GetUsers` | `tests/e2e/identity.e2e.test.ts`、`tests/e2e/tenancy.e2e.test.ts`、`tests/helpers/identity-fixtures.ts` |
| `server/api.go::grpcGatewayRouter` | `tests/e2e/toolchain.e2e.test.ts`、`tests/integration/healthcheck.test.ts` |
| `server/api.go::handleRoutingError` | `tests/e2e/toolchain.e2e.test.ts`、`tests/integration/healthcheck.test.ts` |
| `server/api.go::parseBasicAuth` | `tests/helpers/identity-fixtures.ts` |
| `server/api.go::securityInterceptorFunc` | `tests/e2e/identity.e2e.test.ts`、`tests/e2e/tenancy.e2e.test.ts`、`tests/helpers/identity-fixtures.ts`、`tests/integration/tenancy.test.ts` |
| `server/api.go::wwwAuthenticateFixWriter` | `tests/helpers/identity-fixtures.ts` |
| `server/console_account.go::DeleteWalletLedger` | `tests/integration/competitive/wallet-ledger.test.ts` |
| `server/console_account.go::GetWalletLedger` | `tests/integration/competitive/wallet-ledger.test.ts` |
| `server/core_account.go::UpdateAccounts` | `tests/helpers/identity-fixtures.ts` |
| `server/core_authenticate.go::AuthenticateDevice` | `tests/helpers/identity-fixtures.ts` |
| `server/core_authenticate.go::AuthenticateEmail` | `tests/helpers/identity-fixtures.ts` |
| `server/core_authenticate.go::AuthenticateGoogle` | `tests/integration/social/google-authenticate.test.ts` |
| `server/core_channel.go::BuildChannelId` | `tests/integration/channel/group-access.test.ts`、`tests/integration/channel/ids.test.ts` |
| `server/core_channel.go::ChannelIdToStream` | `tests/integration/channel/ids.test.ts` |
| `server/core_channel.go::ChannelMessageSend` | `tests/integration/channel/messages.test.ts` |
| `server/core_channel.go::ChannelMessagesList` | `tests/e2e/realtime-chat.e2e.test.ts`、`tests/integration/channel/history.test.ts` |
| `server/core_channel.go::StreamToChannelId` | `tests/integration/channel/ids.test.ts` |
| `server/core_friend_test.go::TestServer_ListFriendsOfFriends` | `tests/integration/friends/friends-of-friends.test.ts` |
| `server/core_friend.go::addFriend` | `tests/integration/friends/relations.test.ts` |
| `server/core_friend.go::AddFriends` | `tests/integration/friends/relations.test.ts` |
| `server/core_friend.go::blockFriend` | `tests/integration/friends/delete-block.test.ts` |
| `server/core_friend.go::deleteFriend` | `tests/integration/friends/delete-block.test.ts` |
| `server/core_friend.go::ListFriends` | `tests/integration/friends/list.test.ts` |
| `server/core_friend.go::ListFriendsOfFriends` | `tests/integration/friends/friends-of-friends.test.ts` |
| `server/core_group.go::AddGroupUsers` | `tests/integration/groups/membership.test.ts` |
| `server/core_group.go::BanGroupUsers` | `tests/integration/groups/membership.test.ts` |
| `server/core_group.go::CreateGroup` | `tests/integration/groups/lifecycle.test.ts` |
| `server/core_group.go::DemoteGroupUsers` | `tests/integration/groups/roles.test.ts` |
| `server/core_group.go::groupCheckUserPermission` | `tests/integration/channel/group-access.test.ts` |
| `server/core_group.go::JoinGroup` | `tests/integration/groups/join.test.ts` |
| `server/core_group.go::KickGroupUsers` | `tests/integration/groups/membership.test.ts` |
| `server/core_group.go::ListGroups` | `tests/integration/groups/listing-groups.test.ts` |
| `server/core_group.go::PromoteGroupUsers` | `tests/integration/groups/roles.test.ts` |
| `server/core_notification.go::NotificationCodeDmRequest` | `tests/integration/channel/dm-request.test.ts` |
| `server/core_notification.go::NotificationDelete` | `tests/integration/notifications/delete.test.ts` |
| `server/core_notification.go::NotificationList` | `tests/integration/notifications/list.test.ts` |
| `server/core_session.go::SessionLogout` | `tests/helpers/identity-fixtures.ts`、`tests/unit/tenancy_keys.test.ts` |
| `server/core_session.go::SessionRefresh` | `tests/helpers/identity-fixtures.ts` |
| `server/core_storage.go::StorageDeleteObjects` | `tests/e2e/storage.e2e.test.ts`、`tests/helpers/storage-domain.ts` |
| `server/core_storage.go::storageListObjects` | `tests/integration/storage/domain-extra.test.ts` |
| `server/core_storage.go::StorageListObjects` | `tests/e2e/storage.e2e.test.ts`、`tests/helpers/storage-domain.ts`、`tests/integration/storage/domain-extra.test.ts` |
| `server/core_storage.go::storagePrepBatch` | `tests/integration/storage/domain-extra.test.ts` |
| `server/core_storage.go::StorageReadObjects` | `tests/e2e/storage.e2e.test.ts`、`tests/helpers/storage-domain.ts`、`tests/integration/storage/domain-extra.test.ts` |
| `server/core_storage.go::StorageWriteObjects` | `tests/e2e/storage.e2e.test.ts`、`tests/helpers/storage-domain.ts`、`tests/integration/storage/domain-extra.test.ts` |
| `server/match_presence.go::MatchPresenceList.Join` | `tests/unit/match/presence.test.ts` |
| `server/match_presence.go::MatchPresenceList.Leave` | `tests/unit/match/presence.test.ts` |
| `server/match_registry.go::LocalMatchRegistry.JoinAttempt` | `tests/integration/match/registry.test.ts`、`tests/integration/match/roundtrip.test.ts` |
| `server/match_registry.go::LocalMatchRegistry.ListMatches` | `tests/integration/match/registry.test.ts`、`tests/unit/match/catalog.test.ts`、`tests/unit/match/store.test.ts` |
| `server/match_registry.go::LocalMatchRegistry.UpdateMatchLabel` | `tests/integration/match/registry.test.ts`、`tests/unit/match/store.test.ts` |
| `server/matchmaker.go::LocalMatchmaker.Add` | `tests/e2e/match.e2e.test.ts`、`tests/integration/matchmaker/rounds.test.ts`、`tests/unit/matchmaker/tracking.test.ts` |
| `server/matchmaker.go::LocalMatchmaker.Process` | `tests/integration/matchmaker/rounds.test.ts`、`tests/unit/match/token.test.ts` |
| `server/party_handler.go::PartyHandler.Close` | `tests/integration/party/lifecycle.test.ts` |
| `server/party_handler.go::PartyHandler.DataSend` | `tests/integration/party/frames.test.ts` |
| `server/party_handler.go::PartyHandler.JoinRequest` | `tests/integration/party/lifecycle.test.ts`、`tests/unit/party/members.test.ts` |
| `server/party_handler.go::PartyHandler.Leave` | `tests/integration/party/lifecycle.test.ts` |
| `server/party_handler.go::PartyHandler.MatchmakerAdd` | `tests/integration/party/frames.test.ts` |
| `server/party_handler.go::PartyHandler.Update` | `tests/integration/party/frames.test.ts` |
| `server/party_presence.go::PartyPresenceList.Reserve` | `tests/unit/party/members.test.ts` |
| `server/party_registry.go::LocalPartyRegistry.Create` | `tests/unit/party/label.test.ts` |
| `server/party_registry.go::LocalPartyRegistry.LabelUpdate` | `tests/unit/party/catalog.test.ts`、`tests/unit/party/label.test.ts` |
| `server/party_registry.go::LocalPartyRegistry.PartyList` | `tests/unit/party/catalog.test.ts` |
| `server/pipeline_channel.go::Pipeline.channelJoin` | `tests/integration/channel/dm-request.test.ts`、`tests/integration/channel/join.test.ts`、`tests/integration/channel/validation.test.ts` |
| `server/pipeline_channel.go::Pipeline.channelLeave` | `tests/integration/channel/validation.test.ts` |
| `server/pipeline_channel.go::Pipeline.channelMessageRemove` | `tests/integration/channel/messages.test.ts`、`tests/integration/channel/validation.test.ts` |
| `server/pipeline_channel.go::Pipeline.channelMessageSend` | `tests/e2e/realtime-chat.e2e.test.ts`、`tests/integration/channel/messages.test.ts`、`tests/integration/channel/validation.test.ts` |
| `server/pipeline_channel.go::Pipeline.channelMessageUpdate` | `tests/integration/channel/messages.test.ts`、`tests/integration/channel/validation.test.ts` |
| `server/pipeline_match.go::Pipeline.matchCreate` | `tests/integration/match/pipeline.test.ts`、`tests/unit/uuid.test.ts` |
| `server/pipeline_match.go::Pipeline.matchDataSend` | `tests/integration/match/pipeline.test.ts`、`tests/unit/match/data.test.ts` |
| `server/pipeline_match.go::Pipeline.matchJoin` | `tests/e2e/match.e2e.test.ts`、`tests/integration/match/pipeline.test.ts`、`tests/unit/match/ids.test.ts`、`tests/unit/match/token.test.ts` |
| `server/pipeline_match.go::Pipeline.matchLeave` | `tests/integration/match/pipeline.test.ts`、`tests/unit/match/ids.test.ts` |
| `server/pipeline_matchmaker.go::Pipeline.matchmakerAdd` | `tests/integration/matchmaker/pipeline.test.ts` |
| `server/pipeline_matchmaker.go::Pipeline.matchmakerRemove` | `tests/integration/matchmaker/pipeline.test.ts` |
| `server/pipeline_party.go::Pipeline.partyCreate` | `tests/integration/party/pipeline.test.ts` |
| `server/pipeline_party.go::Pipeline.partyMatchmakerAdd` | `tests/integration/party/pipeline.test.ts` |
| `server/pipeline_party.go::Pipeline.partyMatchmakerRemove` | `tests/integration/party/pipeline.test.ts` |
| `server/pipeline_ping.go::Pipeline.ping` | `tests/integration/realtime/pipeline-basics.test.ts` |
| `server/pipeline_ping.go::Pipeline.pong` | `tests/integration/realtime/pipeline-basics.test.ts` |
| `server/pipeline_status.go::Pipeline.statusFollow` | `tests/e2e/realtime.e2e.test.ts`、`tests/integration/realtime/pipeline-status.test.ts` |
| `server/pipeline_status.go::Pipeline.statusUnfollow` | `tests/integration/realtime/pipeline-status.test.ts` |
| `server/pipeline_status.go::Pipeline.statusUpdate` | `tests/integration/realtime/pipeline-status.test.ts` |
| `server/pipeline.go::Pipeline.ProcessRequest` | `tests/integration/realtime/pipeline-basics.test.ts` |
| `server/session_ws.go::sessionWS.Close` | `tests/integration/channel/presence.test.ts` |
| `server/session_ws.go::sessionWS.maybeResetPingTimer` | `tests/integration/realtime/session-lifecycle.test.ts` |
| `server/session_ws.go::sessionWS.pingNow` | `tests/integration/realtime/session-lifecycle.test.ts` |
| `server/socket_ws.go::extractClientAddressFromRequest` | `tests/integration/realtime/handshake.test.ts` |
| `server/socket_ws.go::NewSocketWsAcceptor` | `tests/e2e/realtime.e2e.test.ts`、`tests/integration/realtime/envelope.test.ts`、`tests/integration/realtime/handshake.test.ts`、`tests/integration/realtime/registry.test.ts` |
| `server/status_registry.go::LocalStatusRegistry.Follow` | `tests/integration/realtime/registry.test.ts` |
| `server/status_registry.go::LocalStatusRegistry.Queue` | `tests/e2e/realtime.e2e.test.ts`、`tests/integration/realtime/registry.test.ts` |
| `server/storage_index.go::LocalStorageIndex.List` | `tests/integration/storage/index-list.test.ts`、`tests/integration/storage/index-write.test.ts` |
| `server/storage_index.go::LocalStorageIndex.mapIndexStorageFields` | `tests/integration/storage/index-write.test.ts` |
| `server/storage_index.go::LocalStorageIndex.Write` | `tests/integration/storage/index-write.test.ts` |
| `server/tracker.go::LocalTracker.Track` | `tests/integration/channel/join.test.ts` |
| `server/tracker.go::LocalTracker.TrackMulti` | `tests/integration/realtime/registry.test.ts` |
| `server/tracker.go::LocalTracker.Untrack` | `tests/integration/channel/presence.test.ts`、`tests/integration/realtime/registry.test.ts` |
| `server/tracker.go::LocalTracker.UntrackAll` | `tests/integration/channel/presence.test.ts` |
| `server/tracker.go::StreamModeChannel` | `tests/integration/channel/ids.test.ts` |
| `vendor/github.com/grpc-ecosystem/grpc-gateway/v2/runtime/errors.go::DefaultHTTPErrorHandler` | `tests/integration/healthcheck.test.ts`、`tests/unit/grpc_status.test.ts` |
| `vendor/github.com/grpc-ecosystem/grpc-gateway/v2/runtime/errors.go::HTTPStatusFromCode` | `tests/e2e/toolchain.e2e.test.ts`、`tests/unit/grpc_status.test.ts` |
<!-- integrity: body_sha256=34630bcebcd20784ac877798a31bf4793f841fa06393635d43aba238395de056 -->
